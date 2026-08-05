import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

import { createRuntimeTaskScheduler } from "../../src/app/runtime.js";
import { DocumentCatalog, type IndexedDocument } from "../../src/documents/catalog/index.js";
import { mapWithConcurrency, type TaskScheduler } from "../../src/shared/concurrency.js";
import type { AppConfig } from "../../src/config/index.js";
import { openDatabase } from "../../src/database/client.js";
import type { RetrievedElement } from "../../src/retrieval/document-retrieval.js";
import type { QueryScope } from "../../src/domain/query-scope.js";
import type { SourceElement } from "../../src/domain/source-elements.js";
import {
  generateEvaluationQuestion,
  judgeEvaluationRelevance,
} from "./inference.js";
import type {
  BenchmarkEvaluationCase,
  BenchmarkEvaluationDataset,
  EvaluationJudgment,
  EvaluationLanguage,
  EvaluationQuestionType,
  EvaluationSplit,
  EvaluationStatisticalDesign,
} from "./dataset.js";
import { createEvaluationCorpusProvenance } from "./dataset.js";
import {
  createEvaluationModelRegistry,
  type EvaluationModelRegistry,
} from "./models.js";
import { regenerateDuplicateQuestions } from "./question-deduplicator.js";
import { createEvaluationModelSeed } from "./seed.js";
import { InferenceCoordinator } from "../../src/inference/coordinator.js";
import { retrieveIndexedDocuments } from "../../src/retrieval/pipeline.js";
import { SourceDocumentStore } from "../../src/documents/storage/source-document-store.js";
import {
  isStandaloneImageFormat,
  readDocumentFormat,
} from "../../src/documents/format.js";
import {
  readCandidateRetrievalMode,
  type EvaluationRetrievalMode,
} from "./retrieval-mode.js";

const HOLDOUT_PERCENT = 20;
const ENRICHMENT_RESULT_COUNT = 20;
const sourceKindOrder: readonly SourceElement["kind"][] = [
  "text",
  "table",
  "image",
];
const poolingModeOrder: readonly EvaluationRetrievalMode[] = [
  "bm25",
  "dense",
  "hybrid",
  "hybrid-reranked",
];

export interface EvaluationCandidatePoolInput {
  mode: EvaluationRetrievalMode;
  retrieved: RetrievedElement[];
}

export interface PooledEvaluationCandidate {
  methods: EvaluationRetrievalMode[];
  retrieved: RetrievedElement;
}

export interface EvaluationGenerationOptions {
  atK: number;
  caseCount: number;
  domain: string;
  enrich: boolean;
  language: EvaluationLanguage;
  questionType: EvaluationQuestionType;
  scope: QueryScope;
  seed: string;
  split: EvaluationSplit;
  statisticalDesign: EvaluationStatisticalDesign;
}

export async function generateEvaluationDataset(
  config: AppConfig,
  options: EvaluationGenerationOptions,
  reportProgress: (message: string) => void,
): Promise<BenchmarkEvaluationDataset> {
  if (options.caseCount < options.statisticalDesign.requiredCaseCount) {
    throw new Error(
      `Evaluation generation requires at least ${options.statisticalDesign.requiredCaseCount} cases for the declared statistical design.`,
    );
  }
  const databaseSession = await openDatabase(config.database);
  try {
    const catalog = new DocumentCatalog(databaseSession.database);
    const selectedTargets = await catalog.resolveQueryScope(
      options.scope,
      config.embeddingSpace.id,
    );
    const selectedDocumentBySource = new Map<string, string>();
    for (const target of selectedTargets) {
      selectedDocumentBySource.set(target.sourceFile, target.documentId);
    }
    const availableDocuments = await catalog.listAvailableDocuments(
      config.embeddingSpace.id,
    );
    const splitDocuments: IndexedDocument[] = [];
    for (const document of availableDocuments) {
      const selectedDocumentId = selectedDocumentBySource.get(document.sourceFile);
      if (
        selectedDocumentId === document.documentId &&
        belongsToEvaluationSplit(document.documentId, options.split, options.seed)
      ) {
        splitDocuments.push(document);
      }
    }
    if (splitDocuments.length === 0) {
      throw new Error(
        `No ${options.split} documents are available in the requested scope.`,
      );
    }

    const documentStore = new SourceDocumentStore(databaseSession.database);
    const elements = await readDocumentElements(documentStore, splitDocuments);
    const documentsById = new Map(
      splitDocuments.map((document) => [document.documentId, document]),
    );
    const selectedElements = selectEvaluationElements(
      elements,
      options.caseCount,
      options.seed,
    );
    const coordinator = new InferenceCoordinator(databaseSession.database);
    await coordinator.configure(config.scheduling);
    const scheduler = createRuntimeTaskScheduler(
      config,
      coordinator,
      "answer",
      "offline-tool",
    );
    const models = createEvaluationModelRegistry(config);
    const cases = await mapWithConcurrency(
      selectedElements,
      scheduler.capacity,
      async (element, index): Promise<BenchmarkEvaluationCase> => {
        const document = documentsById.get(element.documentId);
        if (document === undefined) {
          throw new Error(
            `Evaluation element references an unavailable document: ${element.documentId}.`,
          );
        }
        reportProgress(
          `Generating ${options.domain} ${options.split} question ${index + 1}/${selectedElements.length}`,
        );
        const question = await generateEvaluationQuestion(
          models,
          scheduler,
          {
            domain: options.domain,
            element,
            excludedQuestions: [],
            seed: createEvaluationModelSeed(
              options.seed,
              "question",
              element.id,
            ),
          },
        );
        return {
          domain: options.domain,
          id: createCaseId(options, element),
          origin: {
            documentId: element.documentId,
            elementId: element.id,
            kind: "generated",
            pageNumber: element.pageNumber,
            sourceFile: readPortableSourceFile(element.sourceFile),
            sourceKind: element.kind,
          },
          judgments: [createOriginJudgment(element)],
          metadata: {
            language: options.language,
            questionType: options.questionType,
            source: createEvaluationSource(element),
          },
          question,
          relevantDocumentIds: [],
          relevantElementIds: [element.id],
        };
      },
    );
    const uniqueCases = await regenerateDuplicateQuestions(
      cases,
      selectedElements,
      { domain: options.domain, seed: options.seed },
      models,
      scheduler,
      reportProgress,
    );

    let normalizedCases = uniqueCases;
    if (options.enrich) {
      normalizedCases = await enrichEvaluationCases(
        config,
        uniqueCases,
        models,
        scheduler,
        reportProgress,
        options.seed,
      );
    }
    return {
      atK: options.atK,
      cases: normalizedCases,
      corpus: createEvaluationCorpusProvenance(
        splitDocuments.map((document) => ({
          documentId: document.documentId,
          domain: options.domain,
          modality: isStandaloneImageFormat(readDocumentFormat(document.sourceFile))
            ? "image"
            : "document",
          sourceFile: readPortableSourceFile(document.sourceFile),
        })),
      ),
      name: createStableDatasetName(options.domain, options.split),
      split: options.split,
      access: options.split === "development" ? "development" : "regression",
      statisticalDesign: { ...options.statisticalDesign },
      version: 3,
    };
  } finally {
    await databaseSession.close();
  }
}

export function belongsToEvaluationSplit(
  documentId: string,
  split: EvaluationSplit,
  seed: string,
): boolean {
  const bucket = readStableBucket(`${seed}:document:${documentId}`, 100);
  const belongsToHoldout = bucket >= 100 - HOLDOUT_PERCENT;
  return split === "holdout" ? belongsToHoldout : !belongsToHoldout;
}

export function selectEvaluationElements(
  elements: SourceElement[],
  caseCount: number,
  seed: string,
): SourceElement[] {
  if (!Number.isInteger(caseCount) || caseCount < 1) {
    throw new Error("Evaluation case count must be a positive integer.");
  }
  if (elements.length < caseCount) {
    throw new Error(
      `Requested ${caseCount} evaluation cases, but the selected split contains only ${elements.length} source elements.`,
    );
  }

  const queues = buildElementQueues(elements, seed);
  const selected: SourceElement[] = [];
  const selectedDocuments = new Set<string>();
  selectFromQueues(queues, selected, selectedDocuments, caseCount, true);
  selectFromQueues(queues, selected, selectedDocuments, caseCount, false);
  if (selected.length !== caseCount) {
    throw new Error(
      `Could not select ${caseCount} evaluation elements from ${elements.length} candidates.`,
    );
  }
  return selected;
}

export { createEvaluationModelSeed } from "./seed.js";

async function readDocumentElements(
  store: SourceDocumentStore,
  documents: IndexedDocument[],
): Promise<SourceElement[]> {
  const elements: SourceElement[] = [];
  for (const document of documents) {
    const documentElements = await store.readAllElements(
      document.elementSetId,
      document.sourceFile,
    );
    elements.push(...documentElements);
  }
  return elements;
}

function buildElementQueues(
  elements: SourceElement[],
  seed: string,
): Map<SourceElement["kind"], SourceElement[]> {
  const queues = new Map<SourceElement["kind"], SourceElement[]>();
  for (const kind of sourceKindOrder) {
    queues.set(kind, []);
  }
  const visualIdentities = new Set<string>();
  for (const element of elements) {
    if (element.kind === "image") {
      const identity = createVisualIdentity(element.content);
      if (visualIdentities.has(identity)) {
        continue;
      }
      visualIdentities.add(identity);
    }
    const queue = queues.get(element.kind);
    if (queue === undefined) {
      throw new Error(`Unsupported evaluation source kind: ${element.kind}.`);
    }
    queue.push(element);
  }
  for (const queue of queues.values()) {
    queue.sort((left, right) => {
      const leftRank = readStableRank(`${seed}:element:${left.id}`);
      const rightRank = readStableRank(`${seed}:element:${right.id}`);
      return leftRank.localeCompare(rightRank);
    });
  }
  return queues;
}

function selectFromQueues(
  queues: Map<SourceElement["kind"], SourceElement[]>,
  selected: SourceElement[],
  selectedDocuments: Set<string>,
  caseCount: number,
  requireNewDocument: boolean,
): void {
  while (selected.length < caseCount) {
    let selectedInPass = false;
    for (const kind of sourceKindOrder) {
      const queue = queues.get(kind);
      if (queue === undefined) {
        throw new Error(`Evaluation queue is missing for ${kind}.`);
      }
      const candidateIndex = findCandidateIndex(
        queue,
        selectedDocuments,
        requireNewDocument,
      );
      if (candidateIndex < 0) {
        continue;
      }
      const candidates = queue.splice(candidateIndex, 1);
      const candidate = candidates[0];
      if (candidate === undefined) {
        throw new Error(`Evaluation queue returned no ${kind} candidate.`);
      }
      selected.push(candidate);
      selectedDocuments.add(candidate.documentId);
      selectedInPass = true;
      if (selected.length === caseCount) {
        return;
      }
    }
    if (!selectedInPass) {
      return;
    }
  }
}

function findCandidateIndex(
  queue: SourceElement[],
  selectedDocuments: Set<string>,
  requireNewDocument: boolean,
): number {
  if (!requireNewDocument) {
    return queue.length === 0 ? -1 : 0;
  }
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (
      candidate !== undefined &&
      !selectedDocuments.has(candidate.documentId)
    ) {
      return index;
    }
  }
  return -1;
}

async function enrichEvaluationCases(
  config: AppConfig,
  cases: BenchmarkEvaluationCase[],
  models: EvaluationModelRegistry,
  scheduler: TaskScheduler,
  reportProgress: (message: string) => void,
  seed: string,
): Promise<BenchmarkEvaluationCase[]> {
  const enriched: BenchmarkEvaluationCase[] = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const evaluationCase = cases[caseIndex];
    if (evaluationCase === undefined) {
      throw new Error(`Missing evaluation case at index ${caseIndex}.`);
    }
    reportProgress(
      `Finding alternate evidence for ${evaluationCase.id} (${caseIndex + 1}/${cases.length})`,
    );
    const candidates = await retrievePooledEvaluationCandidates(
      config,
      evaluationCase.question,
      reportProgress,
    );
    const relevantElementIds = new Set(evaluationCase.relevantElementIds);
    const decisions = await mapWithConcurrency(
      candidates,
      scheduler.capacity,
      async (candidate, candidateIndex): Promise<boolean> => {
        const element = candidate.retrieved.element;
        if (relevantElementIds.has(element.id)) {
          return true;
        }
        reportProgress(
          `Judging candidate ${candidateIndex + 1}/${candidates.length} for ${evaluationCase.id}`,
        );
        return judgeEvaluationRelevance(
          models,
          scheduler,
          {
            domain: evaluationCase.domain,
            element,
            evidenceContent: candidate.retrieved.evidenceContent,
            question: evaluationCase.question,
            seed: createEvaluationModelSeed(
              seed,
              "relevance",
              `${evaluationCase.id}:${element.id}`,
            ),
          },
        );
      },
    );
    addRelevantCandidateIds(relevantElementIds, candidates, decisions);
    const judgments = addPooledJudgments(
      evaluationCase,
      candidates,
      decisions,
      models.evaluation.modelId,
    );
    enriched.push({
      ...evaluationCase,
      judgments,
      relevantElementIds: [...relevantElementIds].sort(),
    });
  }
  return enriched;
}

function addPooledJudgments(
  evaluationCase: BenchmarkEvaluationCase,
  candidates: PooledEvaluationCandidate[],
  decisions: boolean[],
  modelId: string,
): EvaluationJudgment[] {
  if (candidates.length !== decisions.length) {
    throw new Error("Relevance decisions do not match retrieval candidates.");
  }
  const judgments = [...evaluationCase.judgments];
  const judgedTargets = new Set<string>();
  for (const judgment of judgments) {
    judgedTargets.add(`${judgment.target.kind}:${judgment.target.id}`);
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const relevant = decisions[index];
    if (candidate === undefined || relevant === undefined) {
      throw new Error(`Missing relevance result at index ${index}.`);
    }
    const element = candidate.retrieved.element;
    const targetKey = `element:${element.id}`;
    if (judgedTargets.has(targetKey)) {
      continue;
    }
    judgments.push({
      provenance: { kind: "pooled", methods: [...candidate.methods] },
      relevance: relevant ? "direct" : "irrelevant",
      review: {
        auditStatus: "pending",
        rationale: relevant
          ? "The configured evaluation model classified this pooled candidate as directly relevant."
          : "The configured evaluation model classified this pooled candidate as irrelevant.",
        reviewedAt: null,
        reviewer: {
          kind: "process",
          name: "evaluation-relevance-model",
          version: modelId,
        },
      },
      target: { id: element.id, kind: "element" },
    });
    judgedTargets.add(targetKey);
  }
  return judgments;
}

async function retrievePooledEvaluationCandidates(
  config: AppConfig,
  question: string,
  reportProgress: (message: string) => void,
): Promise<PooledEvaluationCandidate[]> {
  const inputs: EvaluationCandidatePoolInput[] = [];
  for (const mode of poolingModeOrder) {
    if (mode === "hybrid-reranked" && config.retrieval.reranker === null) {
      continue;
    }
    reportProgress(`Retrieving ${mode} candidates for judgment pooling`);
    const retrievalConfig = buildEnrichmentConfig(config, mode);
    const retrieved = await retrieveIndexedDocuments(
      retrievalConfig,
      question,
      reportProgress,
      { kind: "all" },
      "offline-tool",
    );
    inputs.push({ mode, retrieved });
  }
  return mergePooledEvaluationCandidates(inputs);
}

export function mergePooledEvaluationCandidates(
  inputs: EvaluationCandidatePoolInput[],
): PooledEvaluationCandidate[] {
  const candidates = new Map<string, PooledEvaluationCandidate>();
  for (const input of inputs) {
    for (const retrieved of input.retrieved) {
      const elementId = retrieved.element.id;
      const existing = candidates.get(elementId);
      if (existing === undefined) {
        candidates.set(elementId, {
          methods: [input.mode],
          retrieved,
        });
        continue;
      }
      if (!existing.methods.includes(input.mode)) {
        existing.methods.push(input.mode);
      }
    }
  }
  return [...candidates.values()];
}

function buildEnrichmentConfig(
  config: AppConfig,
  mode: EvaluationRetrievalMode,
): AppConfig {
  const reranker = mode === "hybrid-reranked"
    ? config.retrieval.reranker
    : null;
  return {
    ...config,
    retrieval: {
      ...config.retrieval,
      candidateK: Math.max(
        config.retrieval.candidateK,
        ENRICHMENT_RESULT_COUNT,
      ),
      mode: readCandidateRetrievalMode(mode),
      reranker,
      topK: ENRICHMENT_RESULT_COUNT,
    },
  };
}

function addRelevantCandidateIds(
  relevantElementIds: Set<string>,
  candidates: PooledEvaluationCandidate[],
  decisions: boolean[],
): void {
  if (candidates.length !== decisions.length) {
    throw new Error("Relevance decisions do not match retrieval candidates.");
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const relevant = decisions[index];
    if (candidate !== undefined && relevant === true) {
      relevantElementIds.add(candidate.retrieved.element.id);
    }
  }
}

function createCaseId(
  options: EvaluationGenerationOptions,
  element: SourceElement,
): string {
  const suffix = `${options.split}-${element.id.slice(0, 16)}`;
  return createStablePrefixedName(options.domain, suffix);
}

function createOriginJudgment(element: SourceElement): EvaluationJudgment {
  return {
    provenance: { kind: "origin" },
    relevance: "direct",
    review: {
      auditStatus: "pending",
      rationale: "The generator selected this source element to create the benchmark question.",
      reviewedAt: null,
      reviewer: {
        kind: "process",
        name: "evaluation-generator",
        version: "2",
      },
    },
    target: { id: element.id, kind: "element" },
  };
}

function createEvaluationSource(
  element: SourceElement,
): BenchmarkEvaluationCase["metadata"]["source"] {
  if (element.kind !== "image") {
    return { kind: element.kind };
  }
  return {
    kind: "image",
    visualIdentitySha256: createVisualIdentity(element.content),
  };
}

function createVisualIdentity(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "base64"))
    .digest("hex");
}

function createStableDatasetName(
  domain: string,
  split: EvaluationSplit,
): string {
  return createStablePrefixedName(domain, split);
}

export function readPortableSourceFile(
  sourceFile: string,
  workingDirectory: string = process.cwd(),
): string {
  const relativeSourceFile = relative(workingDirectory, sourceFile);
  if (relativeSourceFile === "") {
    throw new Error("Evaluation source file cannot be the working directory.");
  }
  return relativeSourceFile.split(sep).join("/");
}

function createStablePrefixedName(prefix: string, suffix: string): string {
  const name = `${prefix}-${suffix}`;
  if (name.length <= 120) {
    return name;
  }
  const digest = readStableRank(prefix).slice(0, 8);
  const maximumPrefixLength = 120 - suffix.length - digest.length - 2;
  return `${prefix.slice(0, maximumPrefixLength)}-${digest}-${suffix}`;
}

function readStableBucket(value: string, bucketCount: number): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0) % bucketCount;
}

function readStableRank(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
