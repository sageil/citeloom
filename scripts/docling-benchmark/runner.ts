import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../../src/database/client.js";
import {
  DoclingBenchmarkObserver,
  type DoclingBenchmarkRequestMeasurements,
} from "./observer.js";
import {
  DoclingBenchmarkService,
  type DoclingBenchmarkServiceEnvironment,
} from "./service.js";
import {
  DoclingBenchmarkStore,
  type StartDoclingBenchmarkInput,
  type StoredDoclingBenchmarkResult,
} from "./store.js";
import {
  buildDoclingConversionOptions,
  readDoclingRequestConfiguration,
} from "../../src/docling/client/conversion-request.js";
import {
  partitionDocumentContents,
  type DoclingPartitionResult,
} from "../../src/docling/index.js";
import {
  decodeDoclingBenchmarkProcessConfiguration,
  type DoclingBenchmarkCandidate,
  type DoclingBenchmarkEnvironment,
  type DoclingBenchmarkProcessConfiguration,
  type DoclingPromotionAssessment,
  type DoclingQualityComparison,
} from "./model.js";
import type {
  DoclingConfig,
  DoclingPdfBackend,
  SourceContentConfig,
} from "../../src/config/index.js";
import { evaluateDoclingPromotion } from "./promotion-gate.js";
import {
  compareDoclingOutputQuality,
  fingerprintDoclingOutput,
} from "./quality.js";
import {
  decodeDocumentFormat,
  type DocumentFormat,
  type FileDocumentSource,
} from "../../src/documents/format.js";
import type { SourceElement } from "../../src/domain/source-elements.js";
import { contentIdSchema } from "../../src/domain/validation.js";
import {
  SourceContentStore,
} from "../../src/documents/storage/source-content-store.js";
import {
  documentVersions,
  indexedDocuments,
  ingestionJobs,
  sourceDocuments,
} from "../../src/database/schema.js";

const DEFAULT_ORDER_SEED = 20_260_715;
const DEFAULT_PERFORMANCE_THRESHOLD = 0.1;
const DEFAULT_P95_REGRESSION_LIMIT = 0.1;
const DEFAULT_MEMORY_REGRESSION_LIMIT = 0.1;
const DEFAULT_REPETITIONS = 3;
const benchmarkDocumentRowSchema = z.object({
  byteLength: z.number().int().positive(),
  documentId: contentIdSchema,
  fileExtension: z.string(),
  mediaType: z.string(),
});

interface BenchmarkSourceDocument extends DocumentFormat {
  byteLength: number;
  documentId: string;
}

function createIsolatedBaselineConfig(config: DoclingConfig): DoclingConfig {
  if (config.pdfBackend !== "docling_parse") {
    throw new Error(
      "The benchmark requires docling_parse to remain the production baseline.",
    );
  }
  return {
    ...config,
    apiKey: null,
    baseUrl: "http://127.0.0.1:5002",
    performanceMetricsEnabled: false,
  };
}

function decodeBenchmarkBaselineProcess(
  value: DoclingBenchmarkProcessConfiguration,
): DoclingBenchmarkProcessConfiguration {
  const process = decodeDoclingBenchmarkProcessConfiguration(value);
  if (!process.profilePipelineTimings) {
    throw new Error("The benchmark baseline process must enable profiling.");
  }
  return process;
}
export interface RunDoclingBenchmarkInput {
  baselineConfig: DoclingConfig;
  baselineProcess: DoclingBenchmarkProcessConfiguration;
  baselineSettingsVersion: number;
  includeQualityTradeoffs?: boolean;
  processOnly?: boolean;
  reportProgress?: (message: string) => void;
  resultDatabase: CiteLoomDatabase;
  runId?: string;
  service?: DoclingBenchmarkService;
  sourceContent: SourceContentConfig;
  sourceDatabase: CiteLoomDatabase;
}

export interface DoclingBenchmarkReport {
  assessment: DoclingPromotionAssessment;
  baselineCandidateId: string;
  candidateId: string;
  corpusDocumentCount: number;
  runId: string;
}

interface BenchmarkExecutionContext {
  baselineConfig: DoclingConfig;
  baselineOutputs: Map<string, DoclingPartitionResult>;
  baselineProcess: DoclingBenchmarkProcessConfiguration;
  documents: BenchmarkSourceDocument[];
  initialEnvironment: DoclingBenchmarkEnvironment;
  nextRunOrder: number;
  resultStore: DoclingBenchmarkStore;
  reportProgress: (message: string) => void;
  runId: string;
  service: DoclingBenchmarkService;
  sourceStore: SourceContentStore;
}

interface ExecuteCandidateInput {
  baseline: DoclingPartitionResult | null;
  candidate: DoclingBenchmarkCandidate;
  context: BenchmarkExecutionContext;
  document: BenchmarkSourceDocument;
  forceOutput: boolean;
  repetition: number;
}

interface MeasuredConversion {
  comparison: DoclingQualityComparison | null;
  output: DoclingPartitionResult;
}

interface SafeCandidateExecution {
  failed: boolean;
  measured: MeasuredConversion | null;
}

type CandidateWarmupResult =
  | { outcome: "failure" }
  | { outcome: "success" };

export type DoclingPromotionScreenOutcome =
  | { reason: string; status: "eliminated" }
  | { status: "pending" }
  | { status: "qualified" };

class BenchmarkPromotionConcludedError extends Error {
  public constructor() {
    super("The promotion benchmark concluded before this conversion completed.");
    this.name = "BenchmarkPromotionConcluded";
  }
}

export async function runDoclingCorpusBenchmark(
  input: RunDoclingBenchmarkInput,
): Promise<DoclingBenchmarkReport> {
  const service = input.service ?? new DoclingBenchmarkService();
  const sourceStore = new SourceContentStore(
    input.sourceDatabase,
    input.sourceContent,
  );
  const documents = await readBenchmarkCorpusDocuments(input.sourceDatabase);
  if (documents.length === 0) {
    throw new Error("The Docling benchmark corpus is empty.");
  }
  const baselineConfig = createIsolatedBaselineConfig(input.baselineConfig);
  const baselineProcess = decodeBenchmarkBaselineProcess(input.baselineProcess);
  const processMatrix = createProcessMatrix(
    availableParallelism(),
    baselineProcess,
  );
  const candidates = createBenchmarkCandidates(
    processMatrix,
    baselineConfig,
    baselineProcess,
  );
  const resultStore = new DoclingBenchmarkStore(input.resultDatabase);
  let runId: string | null = null;
  try {
    const serviceEnvironment = await service.start(baselineProcess);
    const initialEnvironment: DoclingBenchmarkEnvironment = {
      ...serviceEnvironment,
      baseline: createBaselineEnvironment(
        baselineConfig,
        input.baselineSettingsVersion,
      ),
      corpusFingerprint: fingerprintBenchmarkCorpus(documents),
    };
    const startInput: StartDoclingBenchmarkInput = {
      candidates,
      corpusDocumentCount: documents.length,
      environment: initialEnvironment,
      orderSeed: DEFAULT_ORDER_SEED,
      p95LatencyRegressionLimit: DEFAULT_P95_REGRESSION_LIMIT,
      peakMemoryRegressionLimit: DEFAULT_MEMORY_REGRESSION_LIMIT,
      performanceThreshold: DEFAULT_PERFORMANCE_THRESHOLD,
      repetitions: DEFAULT_REPETITIONS,
    };
    if (input.runId !== undefined) {
      startInput.runId = input.runId;
    }
    runId = await resultStore.startOrResumeRun(startInput);
    const context: BenchmarkExecutionContext = {
      baselineConfig,
      baselineOutputs: new Map(),
      baselineProcess,
      documents,
      initialEnvironment,
      nextRunOrder: await resultStore.readNextRunOrder(runId),
      resultStore,
      reportProgress: input.reportProgress ?? (() => undefined),
      runId,
      service,
      sourceStore,
    };
    const resumedResults = await resultStore.listResults(runId);
    const resumedScreen = readDoclingPromotionScreenOutcome(
      resumedResults,
      documents.length,
    );
    if (
      resumedScreen.status === "eliminated"
      && input.processOnly !== true
    ) {
      return await completeEliminatedPromotion(
        context,
        candidates,
        resumedScreen.reason,
      );
    }
    const smallest = selectDoclingBenchmarkWarmupDocument(documents);
    if (smallest === undefined) {
      throw new Error("The Docling benchmark has no warmup document.");
    }
    const baselineScreen = requireCandidate(candidates, "screen:docling_parse");
    context.reportProgress(
      `Starting fresh baseline for ${documents.length} corpus document(s).`,
    );
    await warmCandidate(context, baselineScreen, smallest);
    await runBaselineScreen(context, baselineScreen);
    await runBackendScreen(context, candidates);

    let results = await resultStore.listResults(runId);
    const screenOutcome = readDoclingPromotionScreenOutcome(
      results,
      documents.length,
    );
    if (
      screenOutcome.status === "eliminated"
      && input.processOnly !== true
    ) {
      return await completeEliminatedPromotion(
        context,
        candidates,
        screenOutcome.reason,
      );
    }
    if (
      screenOutcome.status !== "qualified"
      && input.processOnly !== true
    ) {
      throw new Error(
        "threaded_docling_parse backend screening ended without a terminal outcome.",
      );
    }
    const qualifyingBackends = input.processOnly === true
      ? new Set<DoclingPdfBackend>(["docling_parse"])
      : readQualifyingBackends(
        candidates,
        results,
        documents.length,
      );
    context.reportProgress(
      input.processOnly === true
        ? "Continuing with process-only tuning on docling_parse."
        : `Backend screen qualified: ${[...qualifyingBackends].join(", ") || "none"}.`,
    );
    await runThreadMatrix(
      context,
      candidates,
      processMatrix,
      qualifyingBackends,
    );

    results = await resultStore.listResults(runId);
    const chosenProcess = selectFairFinalProcess(
      candidates,
      results,
      readRepresentativeDocuments(documents).length,
      qualifyingBackends,
      baselineProcess,
    );
    if (chosenProcess === null) {
      return await completeEliminatedPromotion(
        context,
        candidates,
        "threaded_docling_parse was eliminated because no process configuration passed representative quality and reliability screening.",
      );
    }
    if (input.includeQualityTradeoffs === true) {
      await runQualityTradeoffs(context, candidates);
    }
    context.reportProgress(
      `Finalists use ${describeProcessConfiguration(chosenProcess)}.`,
    );
    const baselineFinal = requireCandidate(
      candidates,
      createFinalCandidateId("docling_parse", chosenProcess),
    );
    const threadedFinal = requireCandidate(
      candidates,
      createFinalCandidateId("threaded_docling_parse", chosenProcess),
    );
    await ensureServiceProcess(context, chosenProcess);
    await warmCandidate(context, baselineFinal, smallest);
    const runThreaded = qualifyingBackends.has("threaded_docling_parse");
    if (runThreaded) {
      const warmup = await warmCandidateSafely(context, threadedFinal, smallest);
      if (warmup.outcome === "failure") {
        await recordEliminatedCandidate(context, threadedFinal, smallest);
        return await completeEliminatedPromotion(
          context,
          candidates,
          "threaded_docling_parse was eliminated because its finalist warmup failed.",
          chosenProcess,
        );
      }
    }
    const finalistsCompleted = await runFinalists(
      context,
      baselineFinal,
      threadedFinal,
      runThreaded,
    );
    if (!finalistsCompleted) {
      return await completeEliminatedPromotion(
        context,
        candidates,
        "threaded_docling_parse was eliminated because a finalist conversion or output-equivalence check failed.",
        chosenProcess,
      );
    }

    results = await resultStore.listResults(runId);
    const assessment = evaluateDoclingPromotion({
      baselineCandidateId: baselineFinal.id,
      candidateId: threadedFinal.id,
      expectedDocumentCount: documents.length,
      p95LatencyRegressionLimit: DEFAULT_P95_REGRESSION_LIMIT,
      peakMemoryRegressionLimit: DEFAULT_MEMORY_REGRESSION_LIMIT,
      performanceThreshold: DEFAULT_PERFORMANCE_THRESHOLD,
      repetitions: DEFAULT_REPETITIONS,
      results,
    });
    await resultStore.completeRun(runId, assessment);
    context.reportProgress(
      assessment.eligible
        ? "threaded_docling_parse passed the promotion evidence gate."
        : "threaded_docling_parse did not pass the promotion evidence gate.",
    );
    return {
      assessment,
      baselineCandidateId: baselineFinal.id,
      candidateId: threadedFinal.id,
      corpusDocumentCount: documents.length,
      runId,
    };
  } catch (error: unknown) {
    if (runId !== null) {
      await resultStore.failRun(runId, error);
    }
    throw error;
  } finally {
    await service.stop();
  }
}

async function readBenchmarkCorpusDocuments(
  database: CiteLoomDatabase,
): Promise<BenchmarkSourceDocument[]> {
  const [publishedRows, versionRows, jobRows] = await Promise.all([
    database
      .select({
        byteLength: sourceDocuments.byteLength,
        documentId: sourceDocuments.documentId,
        fileExtension: documentVersions.fileExtension,
        mediaType: documentVersions.mediaType,
      })
      .from(indexedDocuments)
      .innerJoin(
        documentVersions,
        and(
          eq(indexedDocuments.versionId, documentVersions.id),
          eq(indexedDocuments.documentId, documentVersions.documentId),
        ),
      )
      .innerJoin(
        sourceDocuments,
        eq(indexedDocuments.documentId, sourceDocuments.documentId),
      )
      .orderBy(
        desc(indexedDocuments.indexedAt),
        asc(indexedDocuments.sourceFile),
      ),
    database
      .select({
        byteLength: sourceDocuments.byteLength,
        documentId: sourceDocuments.documentId,
        fileExtension: documentVersions.fileExtension,
        mediaType: documentVersions.mediaType,
      })
      .from(documentVersions)
      .innerJoin(
        sourceDocuments,
        eq(documentVersions.documentId, sourceDocuments.documentId),
      )
      .orderBy(
        desc(documentVersions.createdAt),
        desc(documentVersions.version),
        asc(documentVersions.sourceFile),
      ),
    database
      .select({
        byteLength: sourceDocuments.byteLength,
        documentId: sourceDocuments.documentId,
        fileExtension: ingestionJobs.fileExtension,
        mediaType: ingestionJobs.mediaType,
      })
      .from(ingestionJobs)
      .innerJoin(
        sourceDocuments,
        eq(ingestionJobs.documentId, sourceDocuments.documentId),
      )
      .orderBy(
        desc(ingestionJobs.updatedAt),
        asc(ingestionJobs.sourceFile),
      ),
  ]);
  const documents: BenchmarkSourceDocument[] = [];
  const documentIds = new Set<string>();
  appendBenchmarkDocuments(documents, documentIds, publishedRows);
  appendBenchmarkDocuments(documents, documentIds, jobRows);
  appendBenchmarkDocuments(documents, documentIds, versionRows);
  documents.sort((left, right) => left.documentId.localeCompare(right.documentId));
  return documents;
}

function appendBenchmarkDocuments(
  documents: BenchmarkSourceDocument[],
  documentIds: Set<string>,
  rows: unknown[],
): void {
  for (const row of rows) {
    const result = benchmarkDocumentRowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(
        `Invalid Docling benchmark source row: ${result.error.message}`,
      );
    }
    if (documentIds.has(result.data.documentId)) {
      continue;
    }
    const format = decodeDocumentFormat({
      extension: result.data.fileExtension,
      mediaType: result.data.mediaType,
    });
    documents.push({
      byteLength: result.data.byteLength,
      documentId: result.data.documentId,
      extension: format.extension,
      mediaType: format.mediaType,
    });
    documentIds.add(result.data.documentId);
  }
}

function createBenchmarkCandidates(
  processMatrix: DoclingBenchmarkProcessConfiguration[],
  baselineConfig: DoclingConfig,
  baselineProcess: DoclingBenchmarkProcessConfiguration,
): DoclingBenchmarkCandidate[] {
  const candidates: DoclingBenchmarkCandidate[] = [];
  for (const backend of readBackends()) {
    candidates.push(createCandidate(
      `screen:${backend}`,
      "backend-screen",
      baselineProcess,
      baselineConfig,
      { pdfBackend: backend },
    ));
    for (const processConfig of processMatrix) {
      candidates.push(createCandidate(
        createMatrixCandidateId(backend, processConfig),
        "thread-matrix",
        processConfig,
        baselineConfig,
        { pdfBackend: backend },
      ));
      if (backend !== "pypdfium2") {
        candidates.push(createCandidate(
          createFinalCandidateId(backend, processConfig),
          "finalist",
          processConfig,
          baselineConfig,
          { pdfBackend: backend },
        ));
      }
    }
  }
  candidates.push(createCandidate(
    "tradeoff:ocr:false",
    "quality-tradeoff",
    baselineProcess,
    baselineConfig,
    { ocrEnabled: false },
  ));
  candidates.push(createCandidate(
    "tradeoff:table:false",
    "quality-tradeoff",
    baselineProcess,
    baselineConfig,
    { tableStructureEnabled: false },
  ));
  candidates.push(createCandidate(
    "tradeoff:table:fast",
    "quality-tradeoff",
    baselineProcess,
    baselineConfig,
    { tableMode: "fast" },
  ));
  candidates.push(createCandidate(
    "tradeoff:image-scale:1",
    "quality-tradeoff",
    baselineProcess,
    baselineConfig,
    { secondaryImageScale: 1 },
  ));
  return uniqueCandidates(candidates);
}

function createCandidate(
  id: string,
  phase: DoclingBenchmarkCandidate["phase"],
  processConfig: DoclingBenchmarkProcessConfiguration,
  baselineConfig: DoclingConfig,
  overrides: {
    ocrEnabled?: boolean;
    pdfBackend?: DoclingPdfBackend;
    secondaryImageScale?: number;
    tableMode?: "accurate" | "fast";
    tableStructureEnabled?: boolean;
  },
): DoclingBenchmarkCandidate {
  const config = createBenchmarkRequestConfig(baselineConfig, {
    ocrEnabled: overrides.ocrEnabled ?? baselineConfig.ocrEnabled,
    pdfBackend: overrides.pdfBackend ?? baselineConfig.pdfBackend,
    secondaryImageScale:
      overrides.secondaryImageScale ?? baselineConfig.secondaryImageScale,
    tableMode: overrides.tableMode ?? baselineConfig.tableMode,
    tableStructureEnabled:
      overrides.tableStructureEnabled ?? baselineConfig.tableStructureEnabled,
  });
  const request = readDoclingRequestConfiguration(
    buildDoclingConversionOptions(config, {
      extension: ".pdf",
      mediaType: "application/pdf",
    }),
  );
  return {
    id,
    phase,
    process: processConfig,
    request,
    secondaryImageScale: config.secondaryImageScale,
  };
}

function createBenchmarkRequestConfig(
  baselineConfig: DoclingConfig,
  overrides: {
    ocrEnabled: boolean;
    pdfBackend: DoclingPdfBackend;
    secondaryImageScale: number;
    tableMode: "accurate" | "fast";
    tableStructureEnabled: boolean;
  },
): DoclingConfig {
  return {
    ...baselineConfig,
    apiKey: null,
    baseUrl: "http://127.0.0.1:5002",
    ocrEnabled: overrides.ocrEnabled,
    pdfBackend: overrides.pdfBackend,
    performanceMetricsEnabled: false,
    secondaryImageScale: overrides.secondaryImageScale,
    tableMode: overrides.tableMode,
    tableStructureEnabled: overrides.tableStructureEnabled,
  };
}

async function runBaselineScreen(
  context: BenchmarkExecutionContext,
  candidate: DoclingBenchmarkCandidate,
): Promise<void> {
  for (const document of context.documents) {
    const measured = await executeCandidate({
      baseline: null,
      candidate,
      context,
      document,
      forceOutput: true,
      repetition: 1,
    });
    if (measured === null) {
      throw new Error(`The fresh baseline was not produced for ${document.documentId}.`);
    }
    context.baselineOutputs.set(document.documentId, measured.output);
  }
}

async function runBackendScreen(
  context: BenchmarkExecutionContext,
  candidates: DoclingBenchmarkCandidate[],
): Promise<void> {
  const screen = candidates.filter((candidate) => {
    return candidate.phase === "backend-screen"
      && candidate.id !== "screen:docling_parse";
  });
  for (const candidate of screen) {
    const smallest = selectDoclingBenchmarkWarmupDocument(context.documents);
    if (smallest !== undefined) {
      const warmup = await warmCandidateSafely(context, candidate, smallest);
      if (warmup.outcome === "failure") {
        await recordEliminatedCandidate(context, candidate, smallest);
        continue;
      }
    }
    for (const document of context.documents) {
      const execution = await executeCandidateSafely({
        baseline: readBaseline(context, document.documentId),
        candidate,
        context,
        document,
        forceOutput: false,
        repetition: 1,
      });
      if (
        execution.failed
        || execution.measured?.comparison?.passed === false
      ) {
        context.reportProgress(
          `${candidate.id} was eliminated during backend screening.`,
        );
        break;
      }
    }
  }
}

async function runThreadMatrix(
  context: BenchmarkExecutionContext,
  candidates: DoclingBenchmarkCandidate[],
  processMatrix: DoclingBenchmarkProcessConfiguration[],
  qualifyingBackends: Set<DoclingPdfBackend>,
): Promise<void> {
  const representatives = readRepresentativeDocuments(context.documents);
  for (const processConfig of processMatrix) {
    await ensureServiceProcess(context, processConfig);
    for (const backend of readBackends()) {
      if (!qualifyingBackends.has(backend)) {
        continue;
      }
      const candidate = requireCandidate(
        candidates,
        createMatrixCandidateId(backend, processConfig),
      );
      const smallest = selectDoclingBenchmarkWarmupDocument(context.documents);
      if (smallest !== undefined) {
        const warmup = await warmCandidateSafely(context, candidate, smallest);
        if (warmup.outcome === "failure") {
          await recordEliminatedCandidate(context, candidate, smallest);
          continue;
        }
      }
      for (const document of representatives) {
        const execution = await executeCandidateSafely({
          baseline: readBaseline(context, document.documentId),
          candidate,
          context,
          document,
          forceOutput: false,
          repetition: 1,
        });
        if (
          execution.failed
          || execution.measured?.comparison?.passed === false
        ) {
          context.reportProgress(
            `${candidate.id} was eliminated during process tuning.`,
          );
          break;
        }
      }
    }
  }
}

async function runQualityTradeoffs(
  context: BenchmarkExecutionContext,
  candidates: DoclingBenchmarkCandidate[],
): Promise<void> {
  await ensureServiceProcess(context, context.baselineProcess);
  const tradeoffs = candidates.filter((candidate) => {
    return candidate.phase === "quality-tradeoff";
  });
  const smallest = selectDoclingBenchmarkWarmupDocument(context.documents);
  for (const candidate of tradeoffs) {
    if (smallest !== undefined) {
      const warmup = await warmCandidateSafely(context, candidate, smallest);
      if (warmup.outcome === "failure") {
        await recordEliminatedCandidate(context, candidate, smallest);
        continue;
      }
    }
    for (const document of context.documents) {
      const execution = await executeCandidateSafely({
        baseline: readBaseline(context, document.documentId),
        candidate,
        context,
        document,
        forceOutput: false,
        repetition: 1,
      });
      if (execution.failed) {
        context.reportProgress(
          `${candidate.id} was eliminated after a conversion failure.`,
        );
        break;
      }
    }
  }
}

async function runFinalists(
  context: BenchmarkExecutionContext,
  baseline: DoclingBenchmarkCandidate,
  threaded: DoclingBenchmarkCandidate,
  runThreaded: boolean,
): Promise<boolean> {
  for (let repetition = 1; repetition <= DEFAULT_REPETITIONS; repetition += 1) {
    const documents = shuffleDocuments(
      context.documents,
      DEFAULT_ORDER_SEED + repetition,
    );
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      if (document === undefined) {
        continue;
      }
      const baselineFirst = (index + repetition) % 2 === 0;
      const ordered = baselineFirst ? [baseline, threaded] : [threaded, baseline];
      for (const candidate of ordered) {
        if (candidate.id === threaded.id && !runThreaded) {
          continue;
        }
        const execution = await executeCandidateSafely({
          baseline: readBaseline(context, document.documentId),
          candidate,
          context,
          document,
          forceOutput: false,
          repetition,
        });
        if (
          execution.failed
          || execution.measured?.comparison?.passed === false
        ) {
          context.reportProgress(
            `${candidate.id} was eliminated during finalist measurement.`,
          );
          return false;
        }
      }
    }
  }
  return true;
}

async function completeEliminatedPromotion(
  context: BenchmarkExecutionContext,
  candidates: DoclingBenchmarkCandidate[],
  reason: string,
  processConfig: DoclingBenchmarkProcessConfiguration = context.baselineProcess,
): Promise<DoclingBenchmarkReport> {
  const baselineCandidateId = createFinalCandidateId(
    "docling_parse",
    processConfig,
  );
  const candidateId = createFinalCandidateId(
    "threaded_docling_parse",
    processConfig,
  );
  requireCandidate(candidates, baselineCandidateId);
  requireCandidate(candidates, candidateId);
  const interrupted = await context.resultStore.failIncompleteResults(
    context.runId,
    new BenchmarkPromotionConcludedError(),
  );
  if (interrupted > 0) {
    context.reportProgress(
      `Closed ${interrupted} incomplete benchmark result(s) after the promotion decision became conclusive.`,
    );
  }
  const results = await context.resultStore.listResults(context.runId);
  const evaluated = evaluateDoclingPromotion({
    baselineCandidateId,
    candidateId,
    expectedDocumentCount: context.documents.length,
    p95LatencyRegressionLimit: DEFAULT_P95_REGRESSION_LIMIT,
    peakMemoryRegressionLimit: DEFAULT_MEMORY_REGRESSION_LIMIT,
    performanceThreshold: DEFAULT_PERFORMANCE_THRESHOLD,
    repetitions: DEFAULT_REPETITIONS,
    results,
  });
  const assessment: DoclingPromotionAssessment = {
    ...evaluated,
    reasons: [reason, ...evaluated.reasons],
  };
  await context.resultStore.completeRun(context.runId, assessment);
  context.reportProgress(reason);
  context.reportProgress(
    "Skipped remaining benchmark work because it cannot change the fail-closed promotion decision.",
  );
  return {
    assessment,
    baselineCandidateId,
    candidateId,
    corpusDocumentCount: context.documents.length,
    runId: context.runId,
  };
}

async function executeCandidate(
  input: ExecuteCandidateInput,
): Promise<MeasuredConversion | null> {
  const result = await input.context.resultStore.beginResult(
    input.context.runId,
    {
      candidateId: input.candidate.id,
      documentId: input.document.documentId,
      processConfig: input.candidate.process,
      repetition: input.repetition,
      requestConfig: input.candidate.request,
      runOrder: input.context.nextRunOrder,
    },
  );
  input.context.nextRunOrder += 1;
  if (result.complete && !input.forceOutput) {
    input.context.reportProgress(
      `Reusing completed ${input.candidate.id} result for ${input.document.documentId.slice(0, 12)}.`,
    );
    return null;
  }
  input.context.reportProgress(
    `${input.candidate.id} repetition ${input.repetition} on ${input.document.documentId.slice(0, 12)}.`,
  );
  const stored = await input.context.sourceStore.readDocumentReference(
    input.document.documentId,
  );
  const source: FileDocumentSource = {
    byteLength: stored.byteLength,
    contentPath: stored.contentPath,
    documentId: stored.documentId,
    extension: input.document.extension,
    kind: "file",
    mediaType: input.document.mediaType,
    sourceFile: `benchmark-${stored.documentId}${input.document.extension}`,
  };
  const config = createCandidateConfig(
    input.context.service.baseUrl,
    input.candidate,
    input.context.baselineConfig,
  );
  const observer = new DoclingBenchmarkObserver();
  const measurement = await input.context.service.beginMeasurement();
  const startedAtMs = Date.now();
  try {
    const output = await partitionDocumentContents(
      source,
      config,
      input.context.initialEnvironment.service,
      undefined,
      undefined,
      undefined,
      observer,
    );
    const totalWallMs = Date.now() - startedAtMs;
    const serviceMeasurement = await measurement.finish();
    const observed = observer.read();
    requireProfiling(observed);
    requireNoPollingStorm(serviceMeasurement.statusPollRequestCount, observed);
    const comparison = input.baseline === null
      ? null
      : compareDoclingOutputQuality(input.baseline, output);
    if (!result.complete) {
      const counts = countElements(output.elements);
      const pageCount = output.artifact.document.pages.length;
      await input.context.resultStore.completeResult(result.id, {
        comparison,
        cpuTimeMs: serviceMeasurement.cpuTimeMs,
        httpRequestCount: serviceMeasurement.httpRequestCount,
        httpRequestDurationMs: serviceMeasurement.httpRequestDurationMs,
        imageCount: counts.images,
        outputFingerprint: fingerprintDoclingOutput(output),
        pageCount,
        pagesPerSecond: pageCount / Math.max(totalWallMs / 1_000, 0.001),
        peakResidentBytes: serviceMeasurement.peakResidentBytes,
        processingMs: observed.processingMs,
        profiling: observed.profiling,
        resultRetrievalMs: observed.resultRetrievalMs,
        schedulerWaitMs: 0,
        tableCount: counts.tables,
        taskWaitMs: observed.taskWaitMs,
        textCount: counts.text,
        totalElementCount: output.elements.length,
        totalWallMs,
        uploadMs: observed.uploadMs,
      });
    }
    return { comparison, output };
  } catch (error: unknown) {
    await measurement.finish();
    if (!result.complete) {
      await input.context.resultStore.failResult(result.id, error);
      throw new BenchmarkConversionFailedError(error);
    }
    throw error;
  }
}

async function executeCandidateSafely(
  input: ExecuteCandidateInput,
): Promise<SafeCandidateExecution> {
  try {
    return {
      failed: false,
      measured: await executeCandidate(input),
    };
  } catch (error: unknown) {
    if (error instanceof BenchmarkConversionFailedError) {
      input.context.reportProgress(
        `${input.candidate.id} failed for ${input.document.documentId.slice(0, 12)} and was recorded.`,
      );
      return { failed: true, measured: null };
    }
    throw error;
  }
}

async function recordEliminatedCandidate(
  context: BenchmarkExecutionContext,
  candidate: DoclingBenchmarkCandidate,
  document: BenchmarkSourceDocument,
): Promise<void> {
  context.reportProgress(
    `${candidate.id} warmup failed; recording one measured failure before elimination.`,
  );
  await executeCandidateSafely({
    baseline: readBaseline(context, document.documentId),
    candidate,
    context,
    document,
    forceOutput: false,
    repetition: 1,
  });
}

async function warmCandidate(
  context: BenchmarkExecutionContext,
  candidate: DoclingBenchmarkCandidate,
  document: BenchmarkSourceDocument,
): Promise<void> {
  await ensureServiceProcess(context, candidate.process);
  await executeCandidateWarmup(context, candidate, document);
}

async function warmCandidateSafely(
  context: BenchmarkExecutionContext,
  candidate: DoclingBenchmarkCandidate,
  document: BenchmarkSourceDocument,
): Promise<CandidateWarmupResult> {
  await ensureServiceProcess(context, candidate.process);
  try {
    await executeCandidateWarmup(context, candidate, document);
    return { outcome: "success" };
  } catch {
    context.reportProgress(`${candidate.id} warmup failed and will be eliminated.`);
    return { outcome: "failure" };
  }
}

async function executeCandidateWarmup(
  context: BenchmarkExecutionContext,
  candidate: DoclingBenchmarkCandidate,
  document: BenchmarkSourceDocument,
): Promise<void> {
  const stored = await context.sourceStore.readDocumentReference(
    document.documentId,
  );
  const source: FileDocumentSource = {
    byteLength: stored.byteLength,
    contentPath: stored.contentPath,
    documentId: stored.documentId,
    extension: document.extension,
    kind: "file",
    mediaType: document.mediaType,
    sourceFile: `benchmark-warmup-${stored.documentId}${document.extension}`,
  };
  const observer = new DoclingBenchmarkObserver();
  await partitionDocumentContents(
    source,
    createCandidateConfig(
      context.service.baseUrl,
      candidate,
      context.baselineConfig,
    ),
    context.initialEnvironment.service,
    undefined,
    undefined,
    undefined,
    observer,
  );
  requireProfiling(observer.read());
}

async function ensureServiceProcess(
  context: BenchmarkExecutionContext,
  processConfig: DoclingBenchmarkProcessConfiguration,
): Promise<void> {
  if (sameProcess(context.initialEnvironment.process, processConfig)) {
    return;
  }
  context.reportProgress(
    `Restarting the isolated benchmark service with ${describeProcessConfiguration(processConfig)}.`,
  );
  const environment = await context.service.start(processConfig);
  requireMatchingServiceEnvironment(
    context.initialEnvironment,
    environment,
    processConfig,
  );
  context.initialEnvironment = {
    ...environment,
    baseline: context.initialEnvironment.baseline,
    corpusFingerprint: context.initialEnvironment.corpusFingerprint,
  };
}

function readQualifyingBackends(
  candidates: DoclingBenchmarkCandidate[],
  results: StoredDoclingBenchmarkResult[],
  documentCount: number,
): Set<DoclingPdfBackend> {
  const qualifying = new Set<DoclingPdfBackend>();
  for (const backend of readBackends()) {
    const candidate = requireCandidate(candidates, `screen:${backend}`);
    const candidateResults = selectResults(results, candidate.id);
    if (candidateResults.length !== documentCount) {
      continue;
    }
    let passed = true;
    for (const result of candidateResults) {
      if (result.outcome !== "success") {
        passed = false;
        break;
      }
      if (backend !== "docling_parse" && result.qualityPassed !== true) {
        passed = false;
        break;
      }
    }
    if (passed) {
      qualifying.add(backend);
    }
  }
  return qualifying;
}

export function readDoclingPromotionScreenOutcome(
  results: StoredDoclingBenchmarkResult[],
  expectedDocumentCount: number,
): DoclingPromotionScreenOutcome {
  const candidateResults = selectResults(
    results,
    "screen:threaded_docling_parse",
  );
  if (candidateResults.length > expectedDocumentCount) {
    throw new Error(
      "threaded_docling_parse backend screening stored more results than the corpus contains.",
    );
  }
  let conversionErrors = 0;
  let qualityFailures = 0;
  let timeouts = 0;
  for (const result of candidateResults) {
    if (result.outcome === "error") {
      conversionErrors += 1;
      continue;
    }
    if (result.outcome === "timeout") {
      timeouts += 1;
      continue;
    }
    if (result.outcome === "success" && result.qualityPassed !== true) {
      qualityFailures += 1;
    }
  }
  if (conversionErrors > 0 || timeouts > 0 || qualityFailures > 0) {
    return {
      reason: `threaded_docling_parse failed backend screening with ${conversionErrors} conversion error(s), ${timeouts} timeout(s), and ${qualityFailures} output-equivalence failure(s).`,
      status: "eliminated",
    };
  }
  if (candidateResults.length !== expectedDocumentCount) {
    return { status: "pending" };
  }
  for (const result of candidateResults) {
    if (result.outcome !== "success" || result.qualityPassed !== true) {
      return { status: "pending" };
    }
  }
  return { status: "qualified" };
}

function selectFairFinalProcess(
  candidates: DoclingBenchmarkCandidate[],
  results: StoredDoclingBenchmarkResult[],
  representativeCount: number,
  qualifyingBackends: Set<DoclingPdfBackend>,
  baselineProcess: DoclingBenchmarkProcessConfiguration,
): DoclingBenchmarkProcessConfiguration | null {
  if (!qualifyingBackends.has("threaded_docling_parse")) {
    return baselineProcess;
  }
  let selected: DoclingBenchmarkProcessConfiguration | null = null;
  let selectedWallMs = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (
      candidate.phase !== "thread-matrix"
      || candidate.request.pdfBackend !== "threaded_docling_parse"
    ) {
      continue;
    }
    const candidateResults = selectResults(results, candidate.id);
    if (candidateResults.length !== representativeCount) {
      continue;
    }
    const walls: number[] = [];
    let passed = true;
    for (const result of candidateResults) {
      if (
        result.outcome !== "success"
        || result.qualityPassed !== true
        || result.totalWallMs === null
      ) {
        passed = false;
        break;
      }
      walls.push(result.totalWallMs);
    }
    if (!passed) {
      continue;
    }
    const median = readMedian(walls);
    if (median < selectedWallMs) {
      selected = candidate.process;
      selectedWallMs = median;
    }
  }
  if (selected === null) {
    return null;
  }
  return selected;
}

function createProcessMatrix(
  cpuCount: number,
  baselineProcess: DoclingBenchmarkProcessConfiguration,
): DoclingBenchmarkProcessConfiguration[] {
  const maximumThreads = Math.max(1, cpuCount);
  const candidates: DoclingBenchmarkProcessConfiguration[] = [
    baselineProcess,
    createProcessConfiguration(baselineProcess, {
      loadModelsAtBoot: false,
      optionsCacheSize: 1,
    }),
    createProcessConfiguration(baselineProcess, {
      queueMaxSize: 16,
    }),
    createProcessConfiguration(baselineProcess, {
      layoutBatchSize: 2,
      ocrBatchSize: 2,
      queueMaxSize: 16,
      tableBatchSize: 2,
    }),
    createProcessConfiguration(baselineProcess, {
      layoutBatchSize: 1,
      ocrBatchSize: 1,
      queueMaxSize: 8,
      tableBatchSize: 1,
    }),
    createProcessConfiguration(baselineProcess, {
      loadModelsAtBoot: false,
      localWorkerCount: 1,
      numThreads: Math.min(2, maximumThreads),
      optionsCacheSize: 1,
      queueMaxSize: 16,
    }),
  ];
  const unique: DoclingBenchmarkProcessConfiguration[] = [];
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const identity = processIdentity(candidate);
    if (!identities.has(identity)) {
      identities.add(identity);
      unique.push(candidate);
    }
  }
  return unique;
}

function readRepresentativeDocuments(
  documents: BenchmarkSourceDocument[],
): BenchmarkSourceDocument[] {
  const sorted = [...documents].sort((left, right) => {
    return left.byteLength - right.byteLength;
  });
  const indexes = [0, Math.floor((sorted.length - 1) / 2), sorted.length - 1];
  const representatives: BenchmarkSourceDocument[] = [];
  const identities = new Set<string>();
  for (const index of indexes) {
    const document = sorted[index];
    if (document !== undefined && !identities.has(document.documentId)) {
      identities.add(document.documentId);
      representatives.push(document);
    }
  }
  return representatives;
}

export function selectDoclingBenchmarkWarmupDocument(
  documents: BenchmarkSourceDocument[],
): BenchmarkSourceDocument | undefined {
  const pdfDocuments = documents.filter((document) => document.extension === ".pdf");
  const candidates = pdfDocuments.length > 0 ? pdfDocuments : documents;
  let smallest: BenchmarkSourceDocument | undefined;
  for (const candidate of candidates) {
    if (smallest === undefined || candidate.byteLength < smallest.byteLength) {
      smallest = candidate;
    }
  }
  return smallest;
}

function createCandidateConfig(
  baseUrl: string,
  candidate: DoclingBenchmarkCandidate,
  baselineConfig: DoclingConfig,
): DoclingConfig {
  return {
    ...baselineConfig,
    apiKey: null,
    baseUrl,
    ocrEnabled: candidate.request.doOcr,
    pdfBackend: candidate.request.pdfBackend,
    performanceMetricsEnabled: false,
    secondaryImageScale: candidate.secondaryImageScale,
    tableMode: candidate.request.tableMode ?? "accurate",
    tableStructureEnabled: candidate.request.doTableStructure,
  };
}

function requireMatchingServiceEnvironment(
  initial: DoclingBenchmarkEnvironment,
  current: DoclingBenchmarkServiceEnvironment,
  expectedProcess: DoclingBenchmarkProcessConfiguration,
): void {
  if (
    current.capabilitiesFingerprint !== initial.capabilitiesFingerprint
    || JSON.stringify(current.service) !== JSON.stringify(initial.service)
    || current.imageReference !== initial.imageReference
    || current.ocrPreset !== initial.ocrPreset
    || current.cpuCount !== initial.cpuCount
    || !sameProcess(current.process, expectedProcess)
  ) {
    throw new Error("The isolated Docling benchmark environment changed during the run.");
  }
}

function createBaselineEnvironment(
  config: DoclingConfig,
  settingsVersion: number,
): DoclingBenchmarkEnvironment["baseline"] {
  if (!Number.isInteger(settingsVersion) || settingsVersion < 0) {
    throw new Error("The benchmark baseline settings version is invalid.");
  }
  return {
    baseTimeoutMs: config.baseTimeoutMs,
    maxTimeoutMs: config.maxTimeoutMs,
    megabyteTimeoutMs: config.megabyteTimeoutMs,
    pageTimeoutMs: config.pageTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    settingsVersion,
  };
}

function fingerprintBenchmarkCorpus(
  documents: BenchmarkSourceDocument[],
): string {
  const documentIdentities = documents
    .map((document) => {
      return JSON.stringify([
        document.documentId,
        document.extension,
        document.mediaType,
      ]);
    })
    .sort((left, right) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify(documentIdentities))
    .digest("hex");
}

function requireProfiling(
  measurements: DoclingBenchmarkRequestMeasurements,
): void {
  if (measurements.profiling.length === 0) {
    throw new Error("The benchmark service returned no pipeline profiling stages.");
  }
}

function requireNoPollingStorm(
  statusPollRequestCount: number | null,
  measurements: DoclingBenchmarkRequestMeasurements,
): void {
  if (
    statusPollRequestCount !== null
    && statusPollRequestCount > measurements.reconnectCount
  ) {
    throw new Error(
      `Docling issued ${statusPollRequestCount} status reconciliations for ${measurements.reconnectCount} WebSocket reconnects.`,
    );
  }
}

function countElements(elements: SourceElement[]) {
  let images = 0;
  let tables = 0;
  let text = 0;
  for (const element of elements) {
    if (element.kind === "image") {
      images += 1;
    } else if (element.kind === "table") {
      tables += 1;
    } else {
      text += 1;
    }
  }
  return { images, tables, text };
}

function readBackends(): DoclingPdfBackend[] {
  return ["docling_parse", "threaded_docling_parse", "pypdfium2"];
}

function requireCandidate(
  candidates: DoclingBenchmarkCandidate[],
  id: string,
): DoclingBenchmarkCandidate {
  const candidate = candidates.find((value) => value.id === id);
  if (candidate === undefined) {
    throw new Error(`Missing benchmark candidate ${id}.`);
  }
  return candidate;
}

function uniqueCandidates(
  candidates: DoclingBenchmarkCandidate[],
): DoclingBenchmarkCandidate[] {
  const result: DoclingBenchmarkCandidate[] = [];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) {
      continue;
    }
    ids.add(candidate.id);
    result.push(candidate);
  }
  return result;
}

function readBaseline(
  context: BenchmarkExecutionContext,
  documentId: string,
): DoclingPartitionResult {
  const baseline = context.baselineOutputs.get(documentId);
  if (baseline === undefined) {
    throw new Error(`Missing fresh baseline for document ${documentId}.`);
  }
  return baseline;
}

function selectResults(
  results: StoredDoclingBenchmarkResult[],
  candidateId: string,
): StoredDoclingBenchmarkResult[] {
  return results.filter((result) => result.candidateId === candidateId);
}

function createMatrixCandidateId(
  backend: DoclingPdfBackend,
  processConfig: DoclingBenchmarkProcessConfiguration,
): string {
  return `matrix:${backend}:p${processIdentity(processConfig).slice(0, 16)}`;
}

function createFinalCandidateId(
  backend: Exclude<DoclingPdfBackend, "pypdfium2">,
  processConfig: DoclingBenchmarkProcessConfiguration,
): string {
  return `final:${backend}:p${processIdentity(processConfig).slice(0, 16)}`;
}

function processIdentity(
  processConfig: DoclingBenchmarkProcessConfiguration,
): string {
  const normalized = decodeDoclingBenchmarkProcessConfiguration(processConfig);
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function sameProcess(
  left: DoclingBenchmarkProcessConfiguration,
  right: DoclingBenchmarkProcessConfiguration,
): boolean {
  return isDeepStrictEqual(left, right);
}

function createProcessConfiguration(
  baseline: DoclingBenchmarkProcessConfiguration,
  overrides: Partial<DoclingBenchmarkProcessConfiguration>,
): DoclingBenchmarkProcessConfiguration {
  return decodeDoclingBenchmarkProcessConfiguration({
    ...baseline,
    ...overrides,
  });
}

function describeProcessConfiguration(
  processConfig: DoclingBenchmarkProcessConfiguration,
): string {
  const process = decodeDoclingBenchmarkProcessConfiguration(processConfig);
  return [
    `${process.numThreads} CPU threads`,
    `${process.localWorkerCount} local workers`,
    `queue ${process.queueMaxSize}`,
    `OCR/layout/table batches ${process.ocrBatchSize}/${process.layoutBatchSize}/${process.tableBatchSize}`,
    `model warm-up ${process.loadModelsAtBoot ? "enabled" : "disabled"}`,
    `converter cache ${process.optionsCacheSize}`,
  ].join(", ");
}

function readMedian(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot select a benchmark candidate without measurements.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.POSITIVE_INFINITY;
}

function shuffleDocuments(
  documents: BenchmarkSourceDocument[],
  seed: number,
): BenchmarkSourceDocument[] {
  const shuffled = [...documents];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = ((state * 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex] as BenchmarkSourceDocument;
    shuffled[swapIndex] = current as BenchmarkSourceDocument;
  }
  return shuffled;
}

class BenchmarkConversionFailedError extends Error {
  public constructor(cause: unknown) {
    super("A measured Docling benchmark conversion failed.", { cause });
    this.name = "BenchmarkConversionFailedError";
  }
}
