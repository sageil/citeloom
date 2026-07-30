import { and, count, eq, isNotNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  buildAppConfig,
  parseProviderSettings,
  parseRuntimeSettings,
  runtimeSettingsSchema,
  type AppConfig,
  type DatabaseConfig,
  type DoclingServiceInstanceConfig,
  type DoclingServiceTopology,
  type RuntimeSettingKey,
  type RuntimeSettings,
  type RuntimeSettingsOverrides,
  type RuntimeSettingValue,
} from "../config/index.js";
import type {
  NormalizedProviderSettingsChange,
  ProviderCapability,
  ProviderCapabilityConnection,
  ProviderConnection,
  ProviderConnectionConfiguration,
  ProviderCredentialTarget,
  ProviderId,
  ProviderModelConnection,
  ProviderSettings,
} from "../providers/profiles.js";
import {
  parseStoredApplicationSettings,
  type StoredApplicationSettings,
} from "../providers/settings-persistence.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  applicationSettings,
  indexedDocuments,
  indexedDocumentSpaces,
  ingestionJobs,
  providerOAuthCredentials,
} from "../database/schema.js";
import {
  EmbeddingInputFormatStore,
  type EmbeddingInputFormatRecordWithUsage,
} from "../embedding/input-format-store.js";
import {
  readEmbeddingInputFormatContract,
  type EmbeddingInputFormatContract,
} from "../embedding/input-format-model.js";

const SETTINGS_ID = "runtime";
const runtimeSettingKeySchema = z.enum([
  "aiMetricsEnabled",
  "answerTemperature",
  "answerTimeoutSeconds",
  "backgroundProgressIntervalMs",
  "claimVerifierBaseUrl",
  "claimVerifierRuntimeName",
  "claimVerifierSupportThreshold",
  "claimVerifierTimeoutSeconds",
  "denseWeight",
  "doclingApiKey",
  "doclingBaseUrl",
  "doclingMaxTimeoutSeconds",
  "doclingMegabyteTimeoutSeconds",
  "doclingOcrEnabled",
  "doclingPageTimeoutSeconds",
  "doclingPdfBackend",
  "doclingPerformanceMetricsEnabled",
  "doclingPerformanceMetricsRetentionDays",
  "doclingSecondaryImageScale",
  "doclingTableMode",
  "doclingTableStructureEnabled",
  "doclingDefaultServiceCapacity",
  "doclingRequestTimeoutSeconds",
  "doclingTimeoutSeconds",
  "embeddingDimensions",
  "embeddingInputFormatId",
  "embeddingSpaceId",
  "embeddingTimeoutSeconds",
  "expansionDecay",
  "expansionQueryWeight",
  "generationSeedMode",
  "inferenceThinkingMode",
  "lexicalWeight",
  "maxAttempts",
  "maxDocumentMegabytes",
  "originalQueryWeight",
  "queryExpansions",
  "queryExpansionTemperature",
  "queryExpansionTimeoutSeconds",
  "rerankDiscoveryMinimumScore",
  "rerankTimeoutSeconds",
  "retrievalCandidates",
  "retrievalChunkTargetTokens",
  "retrievalVariantConcurrency",
  "retrievalWindowPolicy",
  "retryBaseMs",
  "rrfK",
  "summaryTimeoutSeconds",
  "sttLanguage",
  "sttMaxAudioMegabytes",
  "sttPrompt",
  "sttTimeoutSeconds",
  "topK",
  "ttsPreloadEnabled",
  "ttsSpeed",
  "ttsTimeoutSeconds",
  "workerConcurrency",
  "workerFallbackPollMs",
]);
const storedSettingsRowSchema = z.object({
  defaults: z.unknown(),
  settings: z.unknown(),
  updatedAt: z.date(),
  version: z.number().int().positive(),
});

export type RuntimeSettingGroup =
  | "Docling"
  | "Inference"
  | "Ingestion recovery"
  | "Models and embeddings"
  | "Reranking"
  | "Retrieval"
  | "Speech-to-text"
  | "Text-to-speech"
  | "Telemetry"
  | "Uploads and ingestion"
  | "Worker scheduling";

export type RuntimeSettingInput =
  | "boolean"
  | "number"
  | "password"
  | "select"
  | "text"
  | "url";

export interface RuntimeSettingOption {
  label: string;
  value: string | number;
}

export interface RuntimeSettingDefinition {
  description: string;
  feature?: ProviderCapability;
  group: RuntimeSettingGroup;
  input: RuntimeSettingInput;
  key: RuntimeSettingKey;
  label: string;
  providerManagedSetting?: boolean;
  nullable?: boolean;
  max?: number;
  min?: number;
  options?: RuntimeSettingOption[];
  sensitive?: boolean;
  step?: number;
  unit?: string;
}

export type NormalizedRuntimeSettingChange =
  | { key: RuntimeSettingKey; reset: true }
  | { key: RuntimeSettingKey; value: RuntimeSettingValue };

export interface EffectiveApplicationSettings {
  config: AppConfig;
  defaults: RuntimeSettings;
  embeddingInputFormats: EmbeddingInputFormatRecordWithUsage[];
  indexedDocumentCount: number;
  overrides: RuntimeSettingsOverrides;
  providerSettings: ProviderSettings;
  runtimeSettings: RuntimeSettings;
  selectedEmbeddingSpaceDocumentCount: number;
  updatedAt: string | null;
  version: number;
}

export class SettingsVersionConflictError extends Error {
  public constructor() {
    super("Settings changed after this page was loaded. Reload and try again.");
    this.name = "SettingsVersionConflictError";
  }
}

export class SettingsValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

export const runtimeSettingDefinitions: readonly RuntimeSettingDefinition[] = [
  setting("claimVerifierRuntimeName", "Inference", "Claim verifier runtime name", "text", "The name shown for the service that checks whether citations support an answer."),
  setting("claimVerifierBaseUrl", "Inference", "Claim verifier base URL", "url", "Where CiteLoom sends citation-support checks."),
  numberSetting("claimVerifierSupportThreshold", "Inference", "Claim support threshold", "How high the model's support score must be before CiteLoom marks a cited claim as supported. The recommended value is 0.50.", 0, 1, 0.01),
  numberSetting("claimVerifierTimeoutSeconds", "Inference", "Claim verifier timeout", "How long CiteLoom waits for a batch of citation-support checks.", 1, 3_600, 1, "seconds"),
  featureSetting(selectSetting("inferenceThinkingMode", "Inference", "Thinking mode", "Reasoning is disabled by default. Enable it only when the configured models and workload benefit from additional reasoning.", [
    { label: "Disabled", value: "disabled" },
    { label: "Enabled", value: "enabled" },
    { label: "Provider default", value: "auto" },
  ]), "answer"),
  featureSetting(numberSetting("answerTimeoutSeconds", "Inference", "Answer deadline", "How long CiteLoom waits for one answer-generation request after it receives a model slot.", 1, 3_600, 1, "seconds"), "answer"),
  featureSetting(numberSetting("answerMaximumOutputTokens", "Inference", "Maximum answer tokens", "The largest structured answer CiteLoom may request after budgeting the complete model context.", 1, 262_144, 1, "tokens"), "answer"),
  featureSetting(numberSetting("answerMinimumOutputTokens", "Inference", "Minimum answer reserve", "The minimum output space required before CiteLoom will attempt structured answer generation.", 1, 262_144, 1, "tokens"), "answer"),
  featureSetting(numberSetting("answerProviderSafetyMarginTokens", "Inference", "Provider safety margin", "Context reserved for provider chat templates and structured-output framing not exposed through the compatible API.", 0, 262_144, 1, "tokens"), "answer"),
  featureSetting(selectSetting("embeddingInputFormatId", "Models and embeddings", "Embedding input format", "How CiteLoom prepares documents and questions for the embedding model.", []), "embedding"),
  featureSetting(positiveIntegerSetting("retrievalChunkTargetTokens", "Models and embeddings", "Retrieval chunk target", "The soft token target used to group nearby content within one document section.", "tokens"), "embedding"),
  featureSetting(numberSetting("embeddingTimeoutSeconds", "Models and embeddings", "Embedding deadline", "How long CiteLoom waits for one embedding request after it receives a model slot.", 1, 86_400, 1, "seconds"), "embedding"),
  featureSetting(numberSetting("summaryTimeoutSeconds", "Models and embeddings", "Description deadline", "How long CiteLoom waits for one table or image description request after it receives a model slot.", 1, 86_400, 1, "seconds"), "summarization"),
  featureSetting(numberSetting("queryExpansionTimeoutSeconds", "Models and embeddings", "Query-expansion deadline", "How long CiteLoom waits for one browser query-expansion request after it receives a model slot.", 1, 3_600, 1, "seconds"), "queryExpansion"),
  featureSetting(selectSetting("embeddingDimensions", "Models and embeddings", "Embedding dimensions", "The number of values stored in each embedding vector.", [
    { label: "384", value: 384 },
    { label: "768", value: 768 },
    { label: "1024", value: 1024 },
  ]), "embedding"),
  featureSetting(nullableSetting("embeddingSpaceId", "Models and embeddings", "Embedding space ID", "text", "The name of the search index for this embedding setup. Leave it blank to let CiteLoom choose one."), "embedding"),
  featureSetting(selectSetting("retrievalWindowPolicy", "Models and embeddings", "Retrieval-window policy", "How CiteLoom constructs indexed child windows within each source element.", [
    { label: "Structured token policy", value: "structured-token-v3" },
  ]), "embedding"),
  setting("doclingBaseUrl", "Docling", "Docling base URL", "url", "Where CiteLoom sends documents for conversion."),
  sensitiveSetting("doclingApiKey", "Docling", "Docling API key", "The secret CiteLoom uses to sign in to Docling."),
  numberSetting("doclingDefaultServiceCapacity", "Docling", "Maximum parallel conversions", "How many documents the default Docling service can convert at the same time across all CiteLoom workers.", 1, 16, 1),
  numberSetting("doclingTimeoutSeconds", "Docling", "Base processing timeout", "The starting amount of processing time given to every Docling job.", 60, 604_800, 1, "seconds"),
  numberSetting("doclingMaxTimeoutSeconds", "Docling", "Task hard deadline", "The longest a Docling job may run before CiteLoom stops waiting.", 60, 604_800, 1, "seconds"),
  numberSetting("doclingPageTimeoutSeconds", "Docling", "Per-page processing budget", "Extra processing time added for each PDF page.", 0, 3_600, 1, "seconds"),
  numberSetting("doclingMegabyteTimeoutSeconds", "Docling", "Per-megabyte processing budget", "Extra processing time added for each megabyte in a document.", 0, 3_600, 1, "seconds"),
  numberSetting("doclingRequestTimeoutSeconds", "Docling", "Request timeout", "How long CiteLoom waits for one upload, status check, or result download.", 10, 3_600, 1, "seconds"),
  setting("doclingPerformanceMetricsEnabled", "Docling", "Conversion performance metrics", "boolean", "Save conversion timing and results without storing document content."),
  numberSetting("doclingPerformanceMetricsRetentionDays", "Docling", "Metrics retention", "How long completed Docling performance records are kept.", 1, 3_650, 1, "days"),
  selectSetting("doclingPdfBackend", "Docling", "PDF backend", "The PDF parser Docling uses.", [
    { label: "Docling Parse", value: "docling_parse" },
    { label: "Threaded Docling Parse", value: "threaded_docling_parse" },
    { label: "PyPDFium2", value: "pypdfium2" },
  ]),
  setting("doclingOcrEnabled", "Docling", "OCR", "boolean", "Read text from scanned pages and other images."),
  setting("doclingTableStructureEnabled", "Docling", "Table structure extraction", "boolean", "Detect rows, columns, and merged cells in tables."),
  selectSetting("doclingTableMode", "Docling", "Table mode", "Choose whether table detection favors accuracy or speed.", [
    { label: "Accurate", value: "accurate" },
    { label: "Fast", value: "fast" },
  ]),
  numberSetting("doclingSecondaryImageScale", "Docling", "Secondary image scale", "How sharp extracted picture images should be. Higher values use more memory.", 0.1, 8, 0.1),
  featureSetting(numberSetting("rerankTimeoutSeconds", "Reranking", "Reranking deadline", "How long CiteLoom waits for one reranking request.", 1, 3_600, 1, "seconds"), "reranking"),
  featureSetting(numberSetting("rerankDiscoveryMinimumScore", "Reranking", "Semantic discovery minimum", "The lowest provider-specific reranker score that Find Sources accepts as a semantic match.", -1_000, 1_000, 0.01), "reranking"),
  numberSetting("retrievalCandidates", "Retrieval", "Candidate count", "How many meaning-based and exact-word matches CiteLoom considers before choosing evidence.", 1, 200, 1),
  numberSetting("retrievalVariantConcurrency", "Retrieval", "Parallel searches", "How many searches CiteLoom may run at the same time for one original question.", 1, 16, 1),
  numberSetting("queryExpansions", "Retrieval", "Extra search queries (Query Expansion)", "The maximum number of extra search queries the AI may write for each original question.", 0, 4, 1),
  numberSetting("queryExpansionTemperature", "Retrieval", "Extra search query variation", "How much the wording of extra search queries may vary between runs.", 0, 2, 0.01),
  numberSetting("answerTemperature", "Retrieval", "Answer variation", "How much the wording of grounded answers may vary between runs.", 0, 2, 0.01),
  selectSetting("generationSeedMode", "Retrieval", "Repeatable generation", "Choose whether CiteLoom asks providers for repeatable model output or lets them choose.", [
    { label: "Stable", value: "stable" },
    { label: "Random", value: "random" },
  ]),
  numberSetting("denseWeight", "Retrieval", "Meaning match weight", "How strongly passages with similar meaning influence which evidence comes first.", 0.01, 100, 0.01),
  numberSetting("lexicalWeight", "Retrieval", "Exact word match weight", "How strongly exact words, names, codes, and phrases influence which evidence comes first.", 0.01, 100, 0.01),
  numberSetting("originalQueryWeight", "Retrieval", "Original question weight", "How strongly searches using the original question influence which evidence comes first.", 0.01, 100, 0.01),
  numberSetting("expansionQueryWeight", "Retrieval", "Extra search weight", "How strongly the first extra search query influences which evidence comes first.", 0.01, 100, 0.01),
  numberSetting("expansionDecay", "Retrieval", "Later extra search influence", "How much influence each later extra search query keeps.", 0.01, 1, 0.01),
  numberSetting("rrfK", "Retrieval", "Search list balance", "How much CiteLoom favors agreement across search lists over small differences in position.", 1, 1_000, 1),
  numberSetting("topK", "Retrieval", "Answer context count", "How many of the best document sections are sent to the answer model.", 1, 50, 1),
  featureSetting(nullableSetting(
    "sttLanguage",
    "Speech-to-text",
    "Language hint",
    "text",
    "A language hint that can improve transcription when the provider supports it.",
  ), "speechToText"),
  featureSetting(nullableSetting(
    "sttPrompt",
    "Speech-to-text",
    "Vocabulary prompt",
    "text",
    "Words or phrases that help the model recognize names and specialist terms.",
  ), "speechToText"),
  featureSetting(numberSetting(
    "sttTimeoutSeconds",
    "Speech-to-text",
    "Transcription deadline",
    "How long CiteLoom waits for a transcription.",
    1,
    300,
    1,
    "seconds",
  ), "speechToText"),
  featureSetting(numberSetting(
    "sttMaxAudioMegabytes",
    "Speech-to-text",
    "Maximum audio size",
    "The largest microphone recording CiteLoom accepts.",
    1,
    25,
    1,
    "MB",
  ), "speechToText"),
  featureSetting(setting(
    "ttsPreloadEnabled",
    "Text-to-speech",
    "Preload answer audio",
    "boolean",
    "Create answer audio in the background as soon as an answer finishes.",
  ), "textToSpeech"),
  featureSetting(numberSetting(
    "ttsSpeed",
    "Text-to-speech",
    "Speech speed",
    "How quickly spoken answers play.",
    0.25,
    5,
    0.05,
  ), "textToSpeech"),
  featureSetting(numberSetting(
    "ttsTimeoutSeconds",
    "Text-to-speech",
    "Speech generation deadline",
    "How long CiteLoom waits for answer audio.",
    1,
    300,
    1,
    "seconds",
  ), "textToSpeech"),
  numberSetting("maxDocumentMegabytes", "Uploads and ingestion", "Maximum document size", "The largest document users can upload or ingest.", 1, 100, 1, "MB"),
  numberSetting("maxAttempts", "Ingestion recovery", "Maximum phase attempts", "How many times CiteLoom retries a failed ingestion phase before stopping.", 1, 20, 1),
  numberSetting("retryBaseMs", "Ingestion recovery", "First retry delay", "How long CiteLoom waits before the first ingestion retry. Later retries wait longer.", 100, 3_600_000, 100, "ms"),
  numberSetting("workerConcurrency", "Worker scheduling", "Ingestion jobs per worker", "How many document jobs one worker can advance at the same time. Provider and Docling capacities still limit external work.", 1, 16, 1),
  numberSetting("backgroundProgressIntervalMs", "Worker scheduling", "Maximum background-work wait", "After this long without starting background AI work, the next available shared AI request is reserved for background work.", 100, 3_600_000, 100, "ms"),
  numberSetting("workerFallbackPollMs", "Worker scheduling", "Missed-notification check interval", "How long an idle worker waits before checking the database when no job or settings notification arrives.", 1_000, 300_000, 1_000, "ms"),
  setting("aiMetricsEnabled", "Telemetry", "AI metrics", "boolean", "Collect AI request timing and usage without saving prompts or answers."),
];

export const runtimeSettingChangeExamples = {
  claimVerifierRuntimeName: "Rename it to “Local claim checker” to make health reports easier to read.",
  claimVerifierBaseUrl: "Point it to http://hhem:8080 when HHEM runs in the Compose network.",
  claimVerifierSupportThreshold: "Raise 0.50 to require stronger evidence, or lower it to mark more borderline claims as supported.",
  claimVerifierTimeoutSeconds: "Raise 120 to 180 if large citation batches time out.",
  inferenceThinkingMode: "Keep Disabled unless you explicitly want compatible models to spend tokens on reasoning.",
  answerTimeoutSeconds: "Raise 900 to 1200 when a large local model needs more than 15 minutes to answer.",
  answerMaximumOutputTokens: "Set this to the largest answer your configured model and product requirements should permit.",
  answerMinimumOutputTokens: "Set this to the smallest output reserve that can hold a valid structured answer.",
  answerProviderSafetyMarginTokens: "Set this from measured provider chat-template and structured-output overhead.",
  embeddingInputFormatId: "Select the format required by the embedding model. Changing it requires reindexing.",
  embeddingDimensions: "Change 768 to 1024 only when the model supports it. Changing dimensions requires reindexing.",
  embeddingSpaceId: "Set a stable name such as legal-v2 to keep that index identity across restarts.",
  embeddingTimeoutSeconds: "Raise 21600 when a local embedding batch needs more than six hours, up to a maximum of 86400.",
  retrievalChunkTargetTokens: "Use 512 for focused evidence chunks. If this exceeds the embedding model context, CiteLoom uses the model context and reports a warning.",
  retrievalWindowPolicy: "Use the structured token policy for deterministic exact-text and table-row windows.",
  summaryTimeoutSeconds: "Raise 21600 when table or image description requests need more than six hours, up to a maximum of 86400.",
  queryExpansionTimeoutSeconds: "Raise 900 when browser extra search query generation needs more than 15 minutes, up to a maximum of 3600.",
  doclingBaseUrl: "Point it to http://docling:5001 when Docling runs in the Compose network.",
  doclingApiKey: "Replace it after Docling rotates its key so document conversions keep working.",
  doclingDefaultServiceCapacity: "Raise 2 to 3 only when the default Docling service can safely convert three documents at once.",
  doclingTimeoutSeconds: "Raise 1800 to 2400 to give every conversion ten more minutes.",
  doclingMaxTimeoutSeconds: "Raise 43200 to 86400 to let very large PDFs run for up to 24 hours.",
  doclingPageTimeoutSeconds: "Raise 30 to 45 to give each PDF page 15 more seconds.",
  doclingMegabyteTimeoutSeconds: "Raise 60 to 90 to give each megabyte 30 more seconds.",
  doclingRequestTimeoutSeconds: "Raise 300 to 600 if uploads, status checks, or result downloads time out.",
  doclingPerformanceMetricsEnabled: "Turn this on before a benchmark to record conversion timing without storing document content.",
  doclingPerformanceMetricsRetentionDays: "Change 30 to 7 to keep one week of metrics instead of one month.",
  doclingPdfBackend: "Try PyPDFium2 when a troublesome PDF does not parse correctly with Docling Parse.",
  doclingOcrEnabled: "Turn this off for text-only PDFs to skip OCR. Scanned pages may then be empty.",
  doclingTableStructureEnabled: "Turn this off for simple documents. Tables will keep less row and cell detail.",
  doclingTableMode: "Choose Fast to reduce processing time when perfect cell structure matters less.",
  doclingSecondaryImageScale: "Raise 2 to 3 for sharper extracted pictures. Conversions will use more memory.",
  rerankDiscoveryMinimumScore: "Tune this against evaluations because reranker score scales differ by model.",
  rerankTimeoutSeconds: "Raise 300 to 600 if large result sets time out before reranking finishes.",
  retrievalCandidates: "Higher values may find evidence that would otherwise be missed, but searching and reranking, when enabled, take more work and may be slower, especially during document ingestion. More candidates do not guarantee a better answer.",
  retrievalVariantConcurrency: "Higher values may finish multi-search questions sooner when the database and providers have spare capacity. They also increase work happening at the same time and can compete with document ingestion.",
  queryExpansions: "Higher values allow more extra search queries, which may find evidence under different terms or in separate sections. Each added search creates more work and may slow the question. The model may still return fewer extra searches, including none.",
  queryExpansionTemperature: "Higher values allow more varied extra search query wording, which may uncover different evidence but makes repeated runs less predictable. It does not guarantee better results.",
  answerTemperature: "Higher values allow more varied answer wording, but make repeated runs less predictable. They do not add evidence or guarantee a better answer.",
  generationSeedMode: "Stable asks compatible providers for repeatable output from the same request. Random allows more variation. Some providers may ignore this choice, and neither option guarantees better results.",
  denseWeight: "Higher values favor passages with similar meaning even when they use different words. This may help with paraphrased questions, but can move exact word matches lower. It does not make searches faster or guarantee a better answer.",
  lexicalWeight: "Higher values favor exact words, names, codes, and quoted phrases. This may help precise searches, but can move useful passages with different wording lower. It does not make searches faster or guarantee a better answer.",
  originalQueryWeight: "Higher values keep evidence closer to the original question. This may help when the original wording is already precise, but reduces the influence of evidence found only by extra search queries. It does not change search speed.",
  expansionQueryWeight: "Higher values give the first extra search query more influence. This may help when different terminology finds useful evidence, but can move results away from the original question. It does not change search speed.",
  expansionDecay: "Higher values let later extra search queries keep more influence. Lower values keep the original question and earlier searches more dominant. This does not change how many searches run or how long they take.",
  rrfK: "Higher values make small position differences within each search list matter less, so agreement across searches matters more. This does not run more searches or guarantee better results.",
  topK: "Higher values send more document sections to the answer model. This may improve coverage, but creates a larger request that can be slower and more expensive. Too much unrelated evidence can also make answers less clear.",
  sttLanguage: "Set en to bias recognition toward English.",
  sttPrompt: "Add “CiteLoom, HHEM, Docling” to help the model recognize project names.",
  sttTimeoutSeconds: "Raise 60 to 120 if long recordings time out.",
  sttMaxAudioMegabytes: "Lower 10 to 5 to reject large recordings sooner and use less memory.",
  ttsPreloadEnabled: "Turn this on so audio is ready sooner, even when nobody presses play.",
  ttsSpeed: "Set 1.25 to play spoken answers 25 percent faster.",
  ttsTimeoutSeconds: "Raise 60 to 120 if long answers time out during speech generation.",
  maxDocumentMegabytes: "Lower 100 to reject oversized documents sooner and reduce storage and processing demand.",
  maxAttempts: "Raise 3 to 5 to keep retrying temporary conversion failures.",
  retryBaseMs: "Raise 5 to 10 so the first retry waits ten seconds instead of five.",
  backgroundProgressIntervalMs: "Lower 5 to 1 to let waiting background work claim a free slot within about one second.",
  workerConcurrency: "Raise 2 to 4 to let one worker advance up to four ingestion jobs. Compute capacities still bound provider requests.",
  workerFallbackPollMs: "Lower 60 to 15 to recover from missed notifications within 15 seconds, with more database checks.",
  aiMetricsEnabled: "Turn this on to show AI request timing and usage in telemetry without storing prompt text.",
} satisfies Record<RuntimeSettingKey, string>;

const definitionByKey = new Map(
  runtimeSettingDefinitions.map((definition) => [definition.key, definition]),
);

export class ApplicationSettingsRepository {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async read(
    databaseConfig: DatabaseConfig,
    doclingTopology: DoclingServiceTopology,
  ): Promise<EffectiveApplicationSettings> {
    const rows = await this.database
      .select()
      .from(applicationSettings)
      .where(eq(applicationSettings.id, SETTINGS_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new SettingsValidationError(
        "The database does not contain application settings.",
      );
    }
    const stored = decodeStoredSettingsRow(row);
    const inputFormats = await new EmbeddingInputFormatStore(
      this.database,
    ).listWithEmbeddingSpaceCounts();
    const settings = buildEffectiveSettings(
      databaseConfig,
      stored,
      doclingTopology,
      inputFormats,
    );
    const availability = await readEmbeddingSpaceAvailability(
      this.database,
      settings.config.embeddingSpace.id,
    );
    return { ...settings, ...availability };
  }

  public async update(
    databaseConfig: DatabaseConfig,
    doclingTopology: DoclingServiceTopology,
    expectedVersion: number,
    changes: NormalizedRuntimeSettingChange[],
    providerChanges: NormalizedProviderSettingsChange[] = [],
  ): Promise<EffectiveApplicationSettings> {
    const settings = await this.database.transaction(async (transaction) => {
      const stored = await readStoredSettingsForUpdate(transaction);
      if (stored === null) {
        throw new SettingsValidationError(
          "The database does not contain application settings.",
        );
      }
      const currentVersion = stored.version;
      if (currentVersion !== expectedVersion) {
        throw new SettingsVersionConflictError();
      }
      const runtimeSettings = applyApplicationSettingsChanges(
        stored,
        changes,
      );
      const inputFormats = await new EmbeddingInputFormatStore(
        transaction,
      ).listWithEmbeddingSpaceCounts();
      const resolved = resolveApplicationSettingsUpdate({
        databaseConfig,
        doclingTopology,
        inputFormats,
        expectedVersion,
        providerChanges,
        runtimeSettings,
        stored,
      });
      await validateDefaultDoclingUrlChange(transaction, resolved);
      await validateOpenAICodexRouteChange(transaction, providerChanges);
      const availability = await readEmbeddingSpaceAvailability(
        transaction,
        resolved.effectiveConfig.embeddingSpace.id,
      );
      if (!resolved.requiresPersistence) {
        return buildApplicationSettingsUpdateResult(
          stored.defaults.runtime,
          resolved,
          stored.updatedAt,
          stored.version,
          availability,
        );
      }

      const updatedAt = new Date();
      const nextVersion = expectedVersion + 1;
      await persistApplicationSettingsUpdate(
        transaction,
        resolved,
        expectedVersion,
        nextVersion,
        updatedAt,
      );
      return buildApplicationSettingsUpdateResult(
        stored.defaults.runtime,
        resolved,
        updatedAt,
        nextVersion,
        availability,
      );
    });
    return settings;
  }
}

type ApplicationSettingsTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

interface ApplicationSettingsUpdateRequest {
  databaseConfig: DatabaseConfig;
  doclingTopology: DoclingServiceTopology;
  inputFormats: EmbeddingInputFormatRecordWithUsage[];
  expectedVersion: number;
  providerChanges: NormalizedProviderSettingsChange[];
  runtimeSettings: RuntimeSettings;
  stored: StoredSettings;
}

interface ResolvedApplicationSettingsUpdate {
  currentDefaultDoclingUrl: string;
  effectiveConfig: AppConfig;
  inputFormats: EmbeddingInputFormatRecordWithUsage[];
  overrides: RuntimeSettingsOverrides;
  providerSettings: ProviderSettings;
  requiresPersistence: boolean;
  runtimeSettings: RuntimeSettings;
  storedSettings: StoredApplicationSettings;
}

async function readStoredSettingsForUpdate(
  transaction: ApplicationSettingsTransaction,
): Promise<StoredSettings | null> {
  const rows = await transaction
    .select()
    .from(applicationSettings)
    .where(eq(applicationSettings.id, SETTINGS_ID))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return decodeStoredSettingsRow(row);
}

function applyApplicationSettingsChanges(
  stored: StoredSettings,
  changes: NormalizedRuntimeSettingChange[],
): RuntimeSettings {
  const next = structuredClone(stored.settings.runtime);
  for (const change of changes) {
    if ("reset" in change) {
      Object.assign(next, {
        [change.key]: stored.defaults.runtime[change.key],
      });
      continue;
    }
    Object.assign(next, { [change.key]: change.value });
  }
  return parseRuntimeSettings(next);
}

function resolveApplicationSettingsUpdate(
  request: ApplicationSettingsUpdateRequest,
): ResolvedApplicationSettingsUpdate {
  try {
    const currentRuntimeSettings = request.stored.settings.runtime;
    const currentProviderSettings = request.stored.settings.providers;
    const currentInputFormat = readSelectedInputFormat(
      request.inputFormats,
      currentRuntimeSettings.embeddingInputFormatId,
    );
    const selectedInputFormat = readSelectedInputFormat(
      request.inputFormats,
      request.runtimeSettings.embeddingInputFormatId,
    );
    const providerSettings = applyProviderSettingsChanges(
      currentProviderSettings,
      request.stored.defaults.providers,
      request.providerChanges,
    );
    const currentConfig = buildAppConfig(
      request.databaseConfig,
      currentRuntimeSettings,
      request.stored.version,
      currentProviderSettings,
      buildDoclingServiceInstances(
        request.doclingTopology,
        currentRuntimeSettings,
      ),
      request.stored.settings.sourceContent,
      currentInputFormat,
    );
    const runtimeSettings = normalizeEmbeddingSpaceIdAfterIdentityChange(
      request,
      currentConfig,
      providerSettings,
      selectedInputFormat,
    );
    const requiresPersistence = hasApplicationSettingsToPersist(
      request.stored,
      runtimeSettings,
      providerSettings,
    );
    const resultVersion = requiresPersistence
      ? request.expectedVersion + 1
      : request.stored.version;
    const effectiveConfig = buildAppConfig(
      request.databaseConfig,
      runtimeSettings,
      resultVersion,
      providerSettings,
      buildDoclingServiceInstances(
        request.doclingTopology,
        runtimeSettings,
      ),
      request.stored.settings.sourceContent,
      selectedInputFormat,
    );
    const storedSettings = parseStoredApplicationSettings({
      providers: providerSettings,
      runtime: runtimeSettings,
      schemaVersion: 1,
      sourceContent: request.stored.settings.sourceContent,
    });
    return {
      currentDefaultDoclingUrl: readDefaultDoclingServiceUrl(currentConfig),
      effectiveConfig,
      inputFormats: request.inputFormats,
      overrides: calculateRuntimeOverrides(
        request.stored.defaults.runtime,
        runtimeSettings,
      ),
      providerSettings,
      requiresPersistence,
      runtimeSettings,
      storedSettings,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Settings are invalid.";
    throw new SettingsValidationError(message);
  }
}

function normalizeEmbeddingSpaceIdAfterIdentityChange(
  request: ApplicationSettingsUpdateRequest,
  currentConfig: AppConfig,
  providerSettings: ProviderSettings,
  inputFormat: EmbeddingInputFormatContract,
): RuntimeSettings {
  const currentSpaceIdOverride =
    request.stored.settings.runtime.embeddingSpaceId;
  if (
    currentSpaceIdOverride === null
    || request.runtimeSettings.embeddingSpaceId !== currentSpaceIdOverride
  ) {
    return request.runtimeSettings;
  }
  const automaticSettings: RuntimeSettings = {
    ...request.runtimeSettings,
    embeddingSpaceId: null,
  };
  const automaticConfig = buildAppConfig(
    request.databaseConfig,
    automaticSettings,
    request.expectedVersion + 1,
    providerSettings,
    buildDoclingServiceInstances(
      request.doclingTopology,
      automaticSettings,
    ),
    request.stored.settings.sourceContent,
    inputFormat,
  );
  if (embeddingSpaceIdentitiesMatch(
    currentConfig.embeddingSpace,
    automaticConfig.embeddingSpace,
  )) {
    return request.runtimeSettings;
  }
  return automaticSettings;
}

function embeddingSpaceIdentitiesMatch(
  left: AppConfig["embeddingSpace"],
  right: AppConfig["embeddingSpace"],
): boolean {
  return left.dimensions === right.dimensions
    && left.inputFormat.id === right.inputFormat.id
    && left.inputFormat.inputFormatHash === right.inputFormat.inputFormatHash
    && left.model === right.model
    && left.retrievalWindow.fingerprint === right.retrievalWindow.fingerprint;
}

function hasApplicationSettingsToPersist(
  stored: StoredSettings,
  runtimeSettings: RuntimeSettings,
  providerSettings: ProviderSettings,
): boolean {
  return !isDeepStrictEqual(stored.settings.runtime, runtimeSettings)
    || !isDeepStrictEqual(stored.settings.providers, providerSettings);
}

async function validateDefaultDoclingUrlChange(
  transaction: ApplicationSettingsTransaction,
  update: ResolvedApplicationSettingsUpdate,
): Promise<void> {
  const effectiveDefaultUrl = readDefaultDoclingServiceUrl(update.effectiveConfig);
  if (update.currentDefaultDoclingUrl === effectiveDefaultUrl) {
    return;
  }
  const assignedJobs = await transaction
    .select({ sourceFile: ingestionJobs.sourceFile })
    .from(ingestionJobs)
    .where(and(
      eq(ingestionJobs.doclingServiceInstanceId, "default"),
      isNotNull(ingestionJobs.doclingServiceSlot),
    ))
    .limit(1);
  if (assignedJobs.length > 0) {
    throw new SettingsValidationError(
      "The default Docling URL cannot change while jobs remain assigned to that service.",
    );
  }
}

async function validateOpenAICodexRouteChange(
  transaction: ApplicationSettingsTransaction,
  changes: NormalizedProviderSettingsChange[],
): Promise<void> {
  const selectsOpenAICodex = changes.some((change) => {
    if (change.action === "route") {
      return change.providerId === "openai-codex";
    }
    if (change.action === "feature") {
      return change.configuration.providerId === "openai-codex";
    }
    return false;
  });
  if (!selectsOpenAICodex) {
    return;
  }
  const rows = await transaction
    .select({ status: providerOAuthCredentials.status })
    .from(providerOAuthCredentials)
    .where(eq(providerOAuthCredentials.providerId, "openai-codex"))
    .limit(1);
  if (rows[0]?.status !== "connected") {
    throw new SettingsValidationError(
      "Sign in to OpenAI Codex before routing an application feature to it.",
    );
  }
}

async function persistApplicationSettingsUpdate(
  transaction: ApplicationSettingsTransaction,
  update: ResolvedApplicationSettingsUpdate,
  expectedVersion: number,
  nextVersion: number,
  updatedAt: Date,
): Promise<void> {
  const updated = await transaction
    .update(applicationSettings)
    .set({
      settings: update.storedSettings,
      updatedAt,
      version: nextVersion,
    })
    .where(and(
      eq(applicationSettings.id, SETTINGS_ID),
      eq(applicationSettings.version, expectedVersion),
    ))
    .returning({ id: applicationSettings.id });
  if (updated.length !== 1) {
    throw new SettingsVersionConflictError();
  }
}

function buildApplicationSettingsUpdateResult(
  defaults: RuntimeSettings,
  update: ResolvedApplicationSettingsUpdate,
  updatedAt: Date | null,
  version: number,
  availability: EmbeddingSpaceAvailability,
): EffectiveApplicationSettings {
  return {
    ...availability,
    config: update.effectiveConfig,
    defaults,
    embeddingInputFormats: update.inputFormats,
    overrides: update.overrides,
    providerSettings: update.providerSettings,
    runtimeSettings: update.runtimeSettings,
    updatedAt: updatedAt?.toISOString() ?? null,
    version,
  };
}

function readDefaultDoclingServiceUrl(config: AppConfig): string {
  const service = config.doclingServices.find((candidate) => {
    return candidate.id === "default";
  });
  if (service === undefined) {
    throw new Error('Docling service configuration has no "default" service.');
  }
  return service.baseUrl;
}

export function decodeRuntimeSettingKey(value: unknown): RuntimeSettingKey {
  const result = runtimeSettingKeySchema.safeParse(value);
  if (!result.success) {
    throw new Error("Unknown runtime setting.");
  }
  return result.data;
}

export function decodeRuntimeSettingValue(
  key: RuntimeSettingKey,
  value: unknown,
): RuntimeSettingValue {
  const definition = definitionByKey.get(key);
  if (definition === undefined) {
    throw new Error(`Runtime setting definition is missing: ${key}.`);
  }
  const schema = runtimeSettingsSchemaForKey(key);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid value for ${definition.label}: ${result.error.issues[0]?.message ?? "invalid value"}.`);
  }
  return result.data;
}

export function isProviderManagedRuntimeSetting(key: RuntimeSettingKey): boolean {
  const definition = definitionByKey.get(key);
  return definition?.providerManagedSetting === true;
}

type EffectiveApplicationSettingsWithoutAvailability = Omit<
  EffectiveApplicationSettings,
  "indexedDocumentCount" | "selectedEmbeddingSpaceDocumentCount"
>;

function buildEffectiveSettings(
  databaseConfig: DatabaseConfig,
  stored: StoredSettings,
  doclingTopology: DoclingServiceTopology,
  inputFormats: EmbeddingInputFormatRecordWithUsage[],
): EffectiveApplicationSettingsWithoutAvailability {
  const defaults = stored.defaults.runtime;
  const runtimeSettings = stored.settings.runtime;
  const providerSettings = stored.settings.providers;
  const inputFormat = readSelectedInputFormat(
    inputFormats,
    runtimeSettings.embeddingInputFormatId,
  );
  return {
    config: buildAppConfig(
      databaseConfig,
      runtimeSettings,
      stored.version,
      providerSettings,
      buildDoclingServiceInstances(doclingTopology, runtimeSettings),
      stored.settings.sourceContent,
      inputFormat,
    ),
    defaults,
    embeddingInputFormats: inputFormats,
    overrides: calculateRuntimeOverrides(defaults, runtimeSettings),
    providerSettings,
    runtimeSettings,
    updatedAt: stored.updatedAt.toISOString(),
    version: stored.version,
  };
}

interface EmbeddingSpaceAvailability {
  indexedDocumentCount: number;
  selectedEmbeddingSpaceDocumentCount: number;
}

type EmbeddingSpaceAvailabilityDatabase = Pick<CiteLoomDatabase, "select">;

async function readEmbeddingSpaceAvailability(
  database: EmbeddingSpaceAvailabilityDatabase,
  embeddingSpaceId: string,
): Promise<EmbeddingSpaceAvailability> {
  const [indexedRows, selectedSpaceRows] = await Promise.all([
    database
      .select({ value: count() })
      .from(indexedDocuments),
    database
      .select({ value: count() })
      .from(indexedDocumentSpaces)
      .innerJoin(
        indexedDocuments,
        and(
          eq(indexedDocumentSpaces.documentId, indexedDocuments.documentId),
          eq(indexedDocumentSpaces.sourceFile, indexedDocuments.sourceFile),
        ),
      )
      .where(eq(indexedDocumentSpaces.embeddingSpaceId, embeddingSpaceId)),
  ]);
  return {
    indexedDocumentCount: readSettingsCount(
      indexedRows,
      "indexed document",
    ),
    selectedEmbeddingSpaceDocumentCount: readSettingsCount(
      selectedSpaceRows,
      "selected embedding-space document",
    ),
  };
}

function readSettingsCount(
  rows: Array<{ value: number }>,
  label: string,
): number {
  const row = rows[0];
  if (row === undefined || !Number.isInteger(row.value) || row.value < 0) {
    throw new Error(`Database returned an invalid ${label} count.`);
  }
  return row.value;
}

function readSelectedInputFormat(
  inputFormats: readonly EmbeddingInputFormatRecordWithUsage[],
  id: string,
): EmbeddingInputFormatContract {
  const inputFormat = inputFormats.find((candidate) => candidate.id === id);
  if (inputFormat === undefined) {
    throw new SettingsValidationError(
      `The selected embedding input format does not exist: ${id}.`,
    );
  }
  if (inputFormat.retiredAt !== null) {
    throw new SettingsValidationError(
      `The selected embedding input format is retired: ${inputFormat.name}.`,
    );
  }
  return readEmbeddingInputFormatContract({
    documentTemplate: inputFormat.documentTemplate,
    id: inputFormat.id,
    inputFormatHash: inputFormat.inputFormatHash,
    name: inputFormat.name,
    queryTemplate: inputFormat.queryTemplate,
    schemaVersion: inputFormat.schemaVersion,
  });
}

function buildDoclingServiceInstances(
  topology: DoclingServiceTopology,
  settings: RuntimeSettings,
): DoclingServiceInstanceConfig[] {
  const services: DoclingServiceInstanceConfig[] = [{
    baseUrl: settings.doclingBaseUrl,
    capacity: settings.doclingDefaultServiceCapacity,
    id: "default",
    process: { ...topology.process },
  }];
  for (const declaration of topology.additionalServices) {
    services.push({
      ...declaration,
      process: { ...topology.process },
    });
  }
  return services;
}

interface StoredSettings {
  defaults: StoredApplicationSettings;
  settings: StoredApplicationSettings;
  updatedAt: Date;
  version: number;
}

function decodeStoredSettingsRow(
  value: unknown,
): StoredSettings {
  const result = storedSettingsRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid application settings row: ${result.error.message}`);
  }
  return {
    defaults: parseStoredApplicationSettings(result.data.defaults),
    settings: parseStoredApplicationSettings(result.data.settings),
    updatedAt: result.data.updatedAt,
    version: result.data.version,
  };
}

function calculateRuntimeOverrides(
  defaults: RuntimeSettings,
  settings: RuntimeSettings,
): RuntimeSettingsOverrides {
  const overrides: RuntimeSettingsOverrides = {};
  for (const key of runtimeSettingKeySchema.options) {
    if (isDeepStrictEqual(defaults[key], settings[key])) {
      continue;
    }
    Object.assign(overrides, { [key]: settings[key] });
  }
  return overrides;
}

export function applyProviderSettingsChanges(
  current: ProviderSettings,
  defaults: ProviderSettings,
  changes: NormalizedProviderSettingsChange[],
): ProviderSettings {
  if (changes.length === 0) {
    return current;
  }
  const reset = changes.find((change) => change.action === "reset");
  if (reset !== undefined) {
    if (changes.length !== 1) {
      throw new Error("Resetting provider settings cannot be combined with other provider changes.");
    }
    return structuredClone(defaults);
  }
  const next = structuredClone(current);
  for (const change of changes) {
    if (change.action === "configure") {
      next.connections[change.providerId] = configureProviderConnection(
        next.connections[change.providerId],
        change.configuration,
        change.providerId,
      );
      continue;
    }
    if (change.action === "credential") {
      if (change.providerId === "openai-codex") {
        throw new SettingsValidationError(
          "OpenAI Codex uses device sign-in instead of API tokens.",
        );
      }
      setProviderCredential(
        next.connections[change.providerId],
        change.target,
        change.value,
      );
      continue;
    }
    if (change.action === "feature") {
      configureApplicationFeature(next, change.configuration);
      continue;
    }
    if (change.action === "route") {
      next.routing[change.capability] = change.providerId;
      next.featureOverrides[change.capability].modelOverride = null;
      if (
        change.capability === "answer"
        || change.capability === "embedding"
        || change.capability === "queryExpansion"
        || change.capability === "summarization"
      ) {
        next.featureOverrides[
          change.capability
        ].contextCapacityTokensOverride = null;
      }
      if (change.capability === "textToSpeech") {
        next.featureOverrides.textToSpeech.voiceOverride = null;
      }
    }
  }
  return parseProviderSettings(next);
}

function configureApplicationFeature(
  settings: ProviderSettings,
  configuration: Extract<
    NormalizedProviderSettingsChange,
    { action: "feature" }
  >["configuration"],
): void {
  const capability = configuration.capability;
  settings.routing[capability] = configuration.providerId;
  settings.featureOverrides[capability].modelOverride =
    configuration.modelOverride;
  if (
    configuration.capability === "answer"
    || configuration.capability === "embedding"
    || configuration.capability === "queryExpansion"
    || configuration.capability === "summarization"
  ) {
    settings.featureOverrides[
      configuration.capability
    ].contextCapacityTokensOverride =
      configuration.contextCapacityTokensOverride;
  }
  if (configuration.capability === "textToSpeech") {
    settings.featureOverrides.textToSpeech.voiceOverride =
      configuration.voiceOverride;
  }
}

function configureProviderConnection(
  current: ProviderConnection,
  configuration: ProviderConnectionConfiguration,
  providerId: ProviderId,
): ProviderConnection {
  validateOpenAICodexConnectionConfiguration(providerId, configuration);
  return {
    adaptiveContextEnabled: configuration.adaptiveContextEnabled,
    apiToken: current.apiToken,
    answer: configureModelConnection(
      current.answer,
      configuration.answer,
    ),
    baseUrl: configuration.baseUrl,
    customAdapters: { ...configuration.customAdapters },
    embedding: configureModelConnection(
      current.embedding,
      configuration.embedding,
    ),
    queryExpansion: configureModelConnection(
      current.queryExpansion,
      configuration.queryExpansion,
    ),
    maximumParallelRequests: configuration.maximumParallelRequests,
    name: configuration.name,
    reranking: configureCapabilityConnection(
      current.reranking,
      configuration.reranking,
    ),
    speechToText: configureCapabilityConnection(
      current.speechToText,
      configuration.speechToText,
    ),
    summarization: configureModelConnection(
      current.summarization,
      configuration.summarization,
    ),
    textToSpeech: {
      ...configureCapabilityConnection(
        current.textToSpeech,
        configuration.textToSpeech,
      ),
      voice: configuration.textToSpeech.voice,
    },
  };
}

function validateOpenAICodexConnectionConfiguration(
  providerId: ProviderId,
  configuration: ProviderConnectionConfiguration,
): void {
  if (providerId !== "openai-codex") {
    return;
  }
  if (
    configuration.baseUrl !== "https://chatgpt.com/backend-api/codex"
    || configuration.answer.baseUrl !== null
    || configuration.queryExpansion.baseUrl !== null
    || configuration.summarization.baseUrl !== null
  ) {
    throw new SettingsValidationError(
      "The OpenAI Codex device credential can only use the fixed ChatGPT Codex endpoint.",
    );
  }
}

function configureCapabilityConnection(
  current: ProviderCapabilityConnection,
  configuration: ProviderConnectionConfiguration["reranking"],
): ProviderCapabilityConnection {
  return {
    apiToken: current.apiToken,
    baseUrl: configuration.baseUrl,
    model: configuration.model,
  };
}

function configureModelConnection(
  current: ProviderModelConnection,
  configuration: ProviderConnectionConfiguration["answer"],
): ProviderModelConnection {
  return {
    ...configureCapabilityConnection(current, configuration),
    contextCapacityTokens: configuration.contextCapacityTokens,
  };
}

function setProviderCredential(
  connection: ProviderConnection,
  target: ProviderCredentialTarget,
  value: string | null,
): void {
  if (target === "shared") {
    connection.apiToken = value;
    connection.answer.apiToken = null;
    connection.embedding.apiToken = null;
    connection.queryExpansion.apiToken = null;
    connection.reranking.apiToken = null;
    connection.speechToText.apiToken = null;
    connection.summarization.apiToken = null;
    connection.textToSpeech.apiToken = null;
    return;
  }
  connection[target].apiToken = value;
}

function runtimeSettingsSchemaForKey(
  key: RuntimeSettingKey,
): z.ZodType<RuntimeSettingValue> {
  return runtimeSettingsSchema.shape[key] as z.ZodType<RuntimeSettingValue>;
}

function setting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  input: RuntimeSettingInput,
  description: string,
): RuntimeSettingDefinition {
  return { description, group, input, key, label };
}

function featureSetting(
  definition: RuntimeSettingDefinition,
  feature: ProviderCapability,
): RuntimeSettingDefinition {
  return { ...definition, feature };
}

function sensitiveSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
): RuntimeSettingDefinition {
  return {
    description,
    group,
    input: "password",
    key,
    label,
    nullable: true,
    sensitive: true,
  };
}

function nullableSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  input: RuntimeSettingInput,
  description: string,
): RuntimeSettingDefinition {
  return { description, group, input, key, label, nullable: true };
}

function numberSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
  min: number,
  max: number,
  step: number,
  unit?: string,
): RuntimeSettingDefinition {
  const definition: RuntimeSettingDefinition = {
    description,
    group,
    input: "number",
    key,
    label,
    max,
    min,
    step,
  };
  if (unit !== undefined) {
    definition.unit = unit;
  }
  return definition;
}

function positiveIntegerSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
  unit: string,
): RuntimeSettingDefinition {
  return {
    description,
    group,
    input: "number",
    key,
    label,
    min: 1,
    step: 1,
    unit,
  };
}

function selectSetting(
  key: RuntimeSettingKey,
  group: RuntimeSettingGroup,
  label: string,
  description: string,
  options: RuntimeSettingOption[],
): RuntimeSettingDefinition {
  return {
    description,
    group,
    input: "select",
    key,
    label,
    options,
  };
}
