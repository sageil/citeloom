import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";

import { readStartupConfig } from "../src/config/index.js";
import { ApplicationSettingsRepository } from "../src/app/settings.js";
import {
  openDatabase,
  type CiteLoomDatabase,
} from "../src/database/client.js";
import {
  DocumentCatalog,
  type IndexedDocument,
} from "../src/documents/catalog/index.js";
import { SourceDocumentStore } from "../src/documents/storage/source-document-store.js";
import {
  isStandaloneImageFormat,
  readDocumentFormat,
} from "../src/documents/format.js";
import type { SourceElement } from "../src/domain/source-elements.js";
import {
  readBenchmarkEvaluationDataset,
  createEvaluationCorpusProvenance,
  decodeEvaluationDataset,
  readEvaluationDataset,
  type EvaluationCorpusDocument,
} from "../tools/evaluation/dataset.js";
import {
  assertLiveEvaluationCorpus,
  inspectLiveEvaluationCorpus,
} from "../tools/evaluation/live-corpus.js";

const knownDatasetPaths = [
  "evaluations/legal.development.json",
  "evaluations/legal.holdout.json",
  "evaluations/veterinary.development.json",
  "evaluations/veterinary.holdout.json",
] as const;
const verbose = process.argv.includes("--verbose");
const applyChanges = process.argv.includes("--apply");
const migrationArguments = readMigrationArguments(process.argv.slice(2));
if (applyChanges && migrationArguments.outputDirectory !== null) {
  throw new Error("--apply and --output-directory cannot be used together.");
}
const requestedDatasetPaths = migrationArguments.datasetPaths;
const datasetPaths = knownDatasetPaths.filter((datasetPath) => {
  return requestedDatasetPaths.size === 0 || requestedDatasetPaths.has(datasetPath);
});
if (datasetPaths.length === 0) {
  throw new Error("No known evaluation datasets were selected for migration.");
}

interface RankedElement {
  element: SourceElement;
  score: number;
}

interface DatasetMigrationPlan {
  datasetPath: string;
  originalContent: string;
  originalSha256: string;
  serializedDataset: string;
}

interface StagedDatasetMigration extends DatasetMigrationPlan {
  temporaryPath: string;
}

interface MigrationArguments {
  datasetPaths: Set<string>;
  outputDirectory: string | null;
}

function readMigrationArguments(arguments_: string[]): MigrationArguments {
  const paths = new Set<string>();
  let outputDirectory: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply" || argument === "--verbose") {
      continue;
    }
    if (argument === "--output-directory") {
      const path = arguments_[index + 1];
      if (path === undefined) {
        throw new Error("--output-directory requires a path.");
      }
      if (outputDirectory !== null) {
        throw new Error("--output-directory was provided more than once.");
      }
      outputDirectory = resolve(path);
      index += 1;
      continue;
    }
    if (argument !== "--dataset") {
      throw new Error(`Unknown evaluation migration option: ${argument}.`);
    }
    const path = arguments_[index + 1];
    if (path === undefined) {
      throw new Error("--dataset requires a repository-relative dataset path.");
    }
    if (!(knownDatasetPaths as readonly string[]).includes(path)) {
      throw new Error(`Unknown evaluation dataset: ${path}.`);
    }
    paths.add(path);
    index += 1;
  }
  return { datasetPaths: paths, outputDirectory };
}

const startup = readStartupConfig();
const session = await openDatabase(startup.database);
try {
  const repository = new ApplicationSettingsRepository(session.database);
  const settings = await repository.read(
    startup.database,
    startup.doclingTopology,
  );
  await reportMigrationCandidates(
    session.database,
    settings.config.embeddingSpace.id,
  );
} finally {
  await session.close();
}

async function reportMigrationCandidates(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
): Promise<void> {
  const catalog = new DocumentCatalog(database);
  const indexed = await catalog.listAvailableDocuments(
    embeddingSpaceId,
  );
  const indexedByDocumentId = new Map<string, IndexedDocument>();
  for (const document of indexed) {
    if (indexedByDocumentId.has(document.documentId)) {
      throw new Error(
        `Active embedding space contains duplicate document ID ${document.documentId}.`,
      );
    }
    indexedByDocumentId.set(document.documentId, document);
  }
  const store = new SourceDocumentStore(database);
  const currentElementsByDocumentId = new Map<string, SourceElement[]>();
  for (const document of indexedByDocumentId.values()) {
    const elements = await store.readAllElements(
      document.elementSetId,
      document.sourceFile,
    );
    currentElementsByDocumentId.set(document.documentId, elements);
  }

  let currentCount = 0;
  let staleCount = 0;
  const plans: DatasetMigrationPlan[] = [];
  for (const datasetPath of datasetPaths) {
    const originalContent = await readFile(datasetPath, "utf8");
    const dataset = readBenchmarkEvaluationDataset(
      await readEvaluationDataset(datasetPath),
      datasetPath,
    );
    for (const evaluationCase of dataset.cases) {
      if (evaluationCase.origin.kind !== "generated") {
        continue;
      }
      const origin = evaluationCase.origin;
      const currentElements = currentElementsByDocumentId.get(origin.documentId);
      const document = indexedByDocumentId.get(origin.documentId);
      if (currentElements === undefined || document === undefined) {
        throw new Error(`Current document is missing: ${origin.sourceFile}.`);
      }
      if (await store.containsElement(document.elementSetId, origin.elementId)) {
        currentCount += 1;
        continue;
      }
      staleCount += 1;
      const historical = await store.readMany([origin.elementId], origin.sourceFile);
      const oldElement = historical[0];
      if (oldElement === undefined) {
        throw new Error(`Historical element is missing: ${origin.elementId}.`);
      }
      const candidates = rankCandidates(oldElement, currentElements).slice(0, 3);
      const best = candidates[0];
      if (best === undefined) {
        throw new Error(`No migration candidate exists for ${origin.elementId}.`);
      }
      const second = candidates[1];
      if (best.score !== 1 || second?.score === 1) {
        throw new Error(
          `Migration candidate for ${origin.elementId} is not a unique normalized-content match.`,
        );
      }
      const report = verbose
        ? {
          candidates: candidates.map((candidate) => ({
            content: previewContent(candidate.element),
            id: candidate.element.id,
            pageNumber: candidate.element.pageNumber,
            score: Number(candidate.score.toFixed(6)),
          })),
          caseId: evaluationCase.id,
          datasetPath,
          old: {
            content: previewContent(oldElement),
            id: oldElement.id,
            pageNumber: oldElement.pageNumber,
          },
          question: evaluationCase.question,
        }
        : {
          caseId: evaluationCase.id,
          datasetPath,
          newElementId: best.element.id,
          oldElementId: oldElement.id,
          score: Number(best.score.toFixed(6)),
        };
      process.stdout.write(`${JSON.stringify(report)}\n`);
      replaceCaseElementId(evaluationCase, origin.elementId, best.element.id);
    }
    migrateDatasetProvenance(
      dataset,
      indexedByDocumentId,
      currentElementsByDocumentId,
    );
    const normalized = readBenchmarkEvaluationDataset(
      decodeEvaluationDataset(dataset, `${datasetPath} migration`),
      `${datasetPath} migration`,
    );
    const liveReport = await inspectLiveEvaluationCorpus(
      database,
      embeddingSpaceId,
      normalized,
      `${datasetPath} migration`,
    );
    assertLiveEvaluationCorpus(liveReport);
    plans.push({
      datasetPath,
      originalContent,
      originalSha256: calculateSha256(originalContent),
      serializedDataset: `${JSON.stringify(normalized, null, 2)}\n`,
    });
  }
  if (applyChanges) {
    await writeMigrationPlansWithRollback(plans);
    for (const plan of plans) {
      process.stdout.write(`${plan.datasetPath}: migrated to current corpus provenance.\n`);
    }
  }
  if (migrationArguments.outputDirectory !== null) {
    await writeMigrationPlanCopies(
      plans,
      migrationArguments.outputDirectory,
    );
  }
  process.stderr.write(`${JSON.stringify({ currentCount, staleCount })}\n`);
}

async function writeMigrationPlanCopies(
  plans: DatasetMigrationPlan[],
  outputDirectory: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for (const plan of plans) {
    const outputPath = resolve(outputDirectory, basename(plan.datasetPath));
    await writeFile(outputPath, plan.serializedDataset, {
      encoding: "utf8",
      flag: "wx",
    });
    process.stdout.write(`${outputPath}: wrote remapped evaluation copy.\n`);
  }
}

async function writeMigrationPlansWithRollback(
  plans: DatasetMigrationPlan[],
): Promise<void> {
  const staged: StagedDatasetMigration[] = [];
  const replaced: StagedDatasetMigration[] = [];
  try {
    for (const plan of plans) {
      const currentContent = await readFile(plan.datasetPath, "utf8");
      if (calculateSha256(currentContent) !== plan.originalSha256) {
        throw new Error(
          `Evaluation dataset changed while the migration was planned: ${plan.datasetPath}.`,
        );
      }
      const temporaryPath = `${plan.datasetPath}.${randomUUID()}.tmp`;
      const stagedPlan = { ...plan, temporaryPath };
      staged.push(stagedPlan);
      await writeFile(temporaryPath, plan.serializedDataset, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    for (const plan of staged) {
      await rename(plan.temporaryPath, plan.datasetPath);
      replaced.push(plan);
    }
  } catch (error: unknown) {
    try {
      await restoreReplacedDatasets(replaced);
    } catch (restorationError: unknown) {
      throw new AggregateError(
        [error, restorationError],
        "Evaluation migration failed and rollback was incomplete.",
      );
    }
    throw error;
  } finally {
    for (const plan of staged) {
      await rm(plan.temporaryPath, { force: true });
    }
  }
}

async function restoreReplacedDatasets(
  replaced: StagedDatasetMigration[],
): Promise<void> {
  for (let index = replaced.length - 1; index >= 0; index -= 1) {
    const plan = replaced[index];
    if (plan === undefined) {
      continue;
    }
    const restorePath = `${plan.datasetPath}.${randomUUID()}.restore`;
    try {
      await writeFile(restorePath, plan.originalContent, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(restorePath, plan.datasetPath);
    } finally {
      await rm(restorePath, { force: true });
    }
  }
}

function rankCandidates(
  oldElement: SourceElement,
  currentElements: SourceElement[],
): RankedElement[] {
  const ranked: RankedElement[] = [];
  for (const candidate of currentElements) {
    if (candidate.kind !== oldElement.kind) {
      continue;
    }
    ranked.push({
      element: candidate,
      score: calculateElementSimilarity(oldElement, candidate),
    });
  }
  ranked.sort((left, right) => {
    const scoreOrder = right.score - left.score;
    if (scoreOrder !== 0) {
      return scoreOrder;
    }
    return left.element.id.localeCompare(right.element.id);
  });
  return ranked;
}

function calculateElementSimilarity(
  oldElement: SourceElement,
  candidate: SourceElement,
): number {
  if (oldElement.kind === "image" && candidate.kind === "image") {
    const oldIdentity = createVisualIdentity(oldElement.content);
    const candidateIdentity = createVisualIdentity(candidate.content);
    return oldIdentity === candidateIdentity ? 1 : 0;
  }
  const oldContent = normalizeContent(oldElement.content);
  const candidateContent = normalizeContent(candidate.content);
  if (oldContent === candidateContent) {
    return 1;
  }
  let score = calculateTokenDice(oldContent, candidateContent) * 0.85;
  if (oldContent.includes(candidateContent) || candidateContent.includes(oldContent)) {
    const containment = Math.min(oldContent.length, candidateContent.length)
      / Math.max(oldContent.length, candidateContent.length);
    score = Math.max(score, 0.7 + containment * 0.2);
  }
  if (oldElement.pageNumber === candidate.pageNumber) {
    score += 0.1;
  }
  if (hasSharedSourceReference(oldElement.sourceRefs, candidate.sourceRefs)) {
    score += 0.05;
  }
  return Math.min(score, 0.999999);
}

function migrateDatasetProvenance(
  dataset: Awaited<ReturnType<typeof readEvaluationDataset>>,
  indexedByDocumentId: Map<string, IndexedDocument>,
  currentElementsByDocumentId: Map<string, SourceElement[]>,
): void {
  if (dataset.corpus === undefined) {
    throw new Error("Evaluation migration requires corpus provenance.");
  }
  const corpusDocuments: EvaluationCorpusDocument[] = [];
  for (const expected of dataset.corpus.documents) {
    const document = indexedByDocumentId.get(expected.documentId);
    if (document === undefined) {
      throw new Error(`Current corpus document is missing: ${expected.sourceFile}.`);
    }
    const format = readDocumentFormat(expected.sourceFile);
    const modality = isStandaloneImageFormat(format) ? "image" : "document";
    corpusDocuments.push({
      documentId: document.documentId,
      domain: expected.domain,
      modality,
      sourceFile: document.sourceFile,
    });
  }
  for (const evaluationCase of dataset.cases) {
    if (evaluationCase.origin.kind !== "generated") {
      continue;
    }
    const origin = evaluationCase.origin;
    const document = indexedByDocumentId.get(origin.documentId);
    const currentElements = currentElementsByDocumentId.get(origin.documentId);
    if (document === undefined || currentElements === undefined) {
      throw new Error(`Current origin document is missing: ${origin.sourceFile}.`);
    }
    const element = currentElements.find((candidate) => {
      return candidate.id === origin.elementId;
    });
    if (element === undefined) {
      throw new Error(`Migrated origin element is not current: ${origin.elementId}.`);
    }
    origin.sourceFile = document.sourceFile;
    if (element.kind === "image" && evaluationCase.metadata.source.kind === "image") {
      evaluationCase.metadata.source.visualIdentitySha256 = createVisualIdentity(
        element.content,
      );
    }
  }
  dataset.corpus = createEvaluationCorpusProvenance(corpusDocuments);
  dataset.version = 3;
}

function replaceCaseElementId(
  evaluationCase: Awaited<ReturnType<typeof readEvaluationDataset>>["cases"][number],
  previousId: string,
  currentId: string,
): void {
  if (evaluationCase.origin.kind === "generated") {
    evaluationCase.origin.elementId = currentId;
  }
  evaluationCase.relevantElementIds = evaluationCase.relevantElementIds.map((id) => {
    return id === previousId ? currentId : id;
  });
  for (const judgment of evaluationCase.judgments) {
    if (judgment.target.kind === "element" && judgment.target.id === previousId) {
      judgment.target.id = currentId;
    }
  }
}

function createVisualIdentity(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "base64"))
    .digest("hex");
}

function calculateSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function calculateTokenDice(left: string, right: string): number {
  const leftTokens = new Set(left.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const rightTokens = new Set(right.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function hasSharedSourceReference(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((reference) => rightSet.has(reference));
}

function normalizeContent(content: string): string {
  return content.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function previewContent(element: SourceElement): string {
  if (element.kind === "image") {
    return `[image ${element.mimeType}, ${element.content.length} base64 characters]`;
  }
  return element.content.replace(/\s+/g, " ").trim().slice(0, 240);
}
