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
  ProviderCapabilityFeatureOverrides,
  ProviderConnection,
  ProviderConnectionConfiguration,
  ProviderCredentialTarget,
  ProviderId,
  ProviderLanguageFeatureOverrides,
  ProviderModelConnection,
  ProviderModelFeatureOverrides,
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
  "chatTemperature",
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
  "doclingTocEnabled",
  "doclingDefaultServiceCapacity",
  "doclingRequestTimeoutSeconds",
  "doclingTimeoutSeconds",
  "embeddingDimensions",
  "embeddingInputFormatId",
  "embeddingSpaceId",
  "embeddingTimeoutSeconds",
  "expansionDecay",
  "expansionQueryWeight",
  "findSourcesPassagesPerDocument",
  "findSourcesResults",
  "generationSeedMode",
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
  | "Answers and citation checks"
  | "Document processing"
  | "Search and answers"
  | "Embedding model"
  | "Search ranking"
  | "Speech input"
  | "Spoken answers"
  | "Usage diagnostics";

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

export interface RuntimeSettingPanel {
  description: string;
  id: string;
  label: string;
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
  panel?: RuntimeSettingPanel;
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

const searchMatchingPanel: RuntimeSettingPanel = {
  description: "Choose how CiteLoom combines results found through similar meaning, matching words, or more than one search.",
  id: "search-matching",
  label: "Search matching",
};

const searchSizePanel: RuntimeSettingPanel = {
  description: "Choose how broadly CiteLoom searches your documents and how much of the strongest matching content Ask and Chat can use.",
  id: "search-size",
  label: "Search size",
};

export const runtimeSettingDefinitions: readonly RuntimeSettingDefinition[] = [
  setting("claimVerifierRuntimeName", "Answers and citation checks", "Citation checker name", "text", "The name shown for the service that checks whether citations support an answer."),
  setting("claimVerifierBaseUrl", "Answers and citation checks", "Citation checker address", "url", "The address of the service that checks whether citations support an answer."),
  numberSetting("claimVerifierSupportThreshold", "Answers and citation checks", "Supported citation score", "The lowest score CiteLoom shows as supported. The recommended value is 0.50.", 0, 1, 0.01),
  numberSetting("claimVerifierTimeoutSeconds", "Answers and citation checks", "Citation check timeout", "How long CiteLoom waits for citation checks to finish.", 1, 3_600, 1, "seconds"),
  featureSetting(numberSetting("answerTemperature", "Answers and citation checks", "Temperature", "How much Ask responses may vary between runs.", 0, 2, 0.01), "answer"),
  featureSetting(numberSetting("answerTimeoutSeconds", "Answers and citation checks", "Answer timeout", "How long CiteLoom waits for an answer to finish.", 1, 3_600, 1, "seconds"), "answer"),
  featureSetting(numberSetting("answerMaximumOutputTokens", "Answers and citation checks", "Maximum answer length", "The most space CiteLoom allows for one answer, measured in model tokens.", 1, 262_144, 1, "tokens"), "answer"),
  featureSetting(numberSetting("answerMinimumOutputTokens", "Answers and citation checks", "Minimum answer space", "The space CiteLoom requires before starting an answer. If less space is available, the request stops instead of returning a cut-off answer.", 1, 262_144, 1, "tokens"), "answer"),
  featureSetting(numberSetting("answerProviderSafetyMarginTokens", "Answers and citation checks", "Reserved model space", "Space kept free so the selected provider can add its required instructions without exceeding the model limit.", 0, 262_144, 1, "tokens"), "answer"),
  featureSetting(numberSetting("chatTemperature", "Answers and citation checks", "Temperature", "How much Chat responses may vary between runs.", 0, 2, 0.01), "chat"),
  featureSetting(selectSetting("embeddingInputFormatId", "Embedding model", "Search text format", "The text format required by the selected embedding model.", []), "embedding"),
  featureSetting(positiveIntegerSetting("retrievalChunkTargetTokens", "Embedding model", "Document section size", "The preferred size of searchable document sections. Smaller values create more focused sections, while larger values keep more nearby text together.", "tokens"), "embedding"),
  featureSetting(numberSetting("embeddingTimeoutSeconds", "Embedding model", "Embedding model timeout", "How long CiteLoom waits for the embedding model while indexing documents or searching.", 1, 86_400, 1, "seconds"), "embedding"),
  featureSetting(numberSetting("summaryTimeoutSeconds", "Document processing", "Indexing model timeout", "How long CiteLoom waits for the indexing model while preparing document content for search.", 1, 86_400, 1, "seconds"), "summarization"),
  featureSetting(numberSetting("queryExpansions", "Search and answers", "Number of expansions", "How many alternative searches CiteLoom may create for one question. Set this to 0 to search only the original wording.", 0, 4, 1), "queryExpansion"),
  featureSetting(numberSetting("queryExpansionTemperature", "Search and answers", "Temperature", "How much generated search wording may vary. Set this to 0 for the most repeatable wording.", 0, 2, 0.01), "queryExpansion"),
  featureSetting(numberSetting("originalQueryWeight", "Search and answers", "Original question influence", "How strongly results found using the original question affect the final search order compared with query expansions.", 0.01, 100, 0.01), "queryExpansion"),
  featureSetting(numberSetting("expansionQueryWeight", "Search and answers", "First expansion influence", "How strongly results found using the first query expansion affect the final search order compared with the original question.", 0.01, 100, 0.01), "queryExpansion"),
  featureSetting(numberSetting("expansionDecay", "Search and answers", "Later expansion influence", "How much influence each later expansion keeps from the expansion before it. A value of 1 gives every expansion equal influence; lower values reduce the influence of later expansions.", 0.01, 1, 0.01), "queryExpansion"),
  featureSetting(numberSetting("queryExpansionTimeoutSeconds", "Search and answers", "Timeout", "How long CiteLoom waits for query expansions before stopping the request.", 1, 3_600, 1, "seconds"), "queryExpansion"),
  featureSetting(selectSetting("embeddingDimensions", "Embedding model", "Embedding dimensions", "Choose the value required by the selected embedding model.", [
    { label: "384", value: 384 },
    { label: "768", value: 768 },
    { label: "1024", value: 1024 },
  ]), "embedding"),
  featureSetting(nullableSetting("embeddingSpaceId", "Embedding model", "Search index name", "text", "An optional name for this search setup. Leave it blank to let CiteLoom choose one."), "embedding"),
  featureSetting(selectSetting("retrievalWindowPolicy", "Embedding model", "Document section method", "How CiteLoom keeps nearby document content together for search.", [
    { label: "Keep document structure", value: "structured-token-v3" },
  ]), "embedding"),
  setting("doclingBaseUrl", "Docling", "Docling base URL", "url", "Where CiteLoom sends documents for conversion."),
  sensitiveSetting("doclingApiKey", "Docling", "Docling API key", "The secret CiteLoom uses to sign in to Docling."),
  numberSetting("doclingDefaultServiceCapacity", "Docling", "Documents converted at once", "How many documents Docling can convert at the same time.", 1, 16, 1),
  numberSetting("doclingTimeoutSeconds", "Docling", "Standard conversion time", "The time allowed for every document before page and file-size allowances are added.", 60, 604_800, 1, "seconds"),
  numberSetting("doclingMaxTimeoutSeconds", "Docling", "Maximum conversion time", "The longest CiteLoom waits for one document conversion.", 60, 604_800, 1, "seconds"),
  numberSetting("doclingPageTimeoutSeconds", "Docling", "Extra time per PDF page", "The conversion time added for each PDF page.", 0, 3_600, 1, "seconds"),
  numberSetting("doclingMegabyteTimeoutSeconds", "Docling", "Extra time per megabyte", "The conversion time added for each megabyte in a document.", 0, 3_600, 1, "seconds"),
  numberSetting("doclingRequestTimeoutSeconds", "Docling", "Docling connection timeout", "How long CiteLoom waits while sending a document to Docling, checking progress, or downloading the result.", 10, 3_600, 1, "seconds"),
  setting("doclingPerformanceMetricsEnabled", "Docling", "Conversion diagnostics", "boolean", "Save conversion times and outcomes without saving document content."),
  numberSetting("doclingPerformanceMetricsRetentionDays", "Docling", "Conversion history", "How long CiteLoom keeps completed conversion diagnostics.", 1, 3_650, 1, "days"),
  selectSetting("doclingPdfBackend", "Docling", "PDF reader", "The PDF reader Docling uses.", [
    { label: "Docling Parse", value: "docling_parse" },
    { label: "Threaded Docling Parse", value: "threaded_docling_parse" },
    { label: "PyPDFium2", value: "pypdfium2" },
  ]),
  setting("doclingOcrEnabled", "Docling", "Read scanned text", "boolean", "Read text from scanned pages and other images."),
  setting("doclingTableStructureEnabled", "Docling", "Preserve table structure", "boolean", "Detect rows, columns, and merged cells in tables."),
  setting(
    "doclingTocEnabled",
    "Docling",
    "Use document headings in search",
    "boolean",
    "Use a document's headings to help Ask and Chat find relevant sections in long documents. Run the documented update command so existing documents also benefit.",
  ),
  selectSetting("doclingTableMode", "Docling", "Table reading priority", "Choose whether reading tables favors accuracy or speed.", [
    { label: "Accurate", value: "accurate" },
    { label: "Fast", value: "fast" },
  ]),
  numberSetting("doclingSecondaryImageScale", "Docling", "Extracted image quality", "How sharp extracted images should be. Higher values use more memory.", 0.1, 8, 0.1),
  featureSetting(numberSetting("rerankTimeoutSeconds", "Search ranking", "Search ranking timeout", "How long CiteLoom waits for semantic search results to be sorted.", 1, 3_600, 1, "seconds"), "reranking"),
  featureSetting(numberSetting("rerankDiscoveryMinimumScore", "Search ranking", "Minimum score for Find Sources", "The lowest semantic-match score Find Sources shows. Higher values show fewer matches. Each search ranking model uses its own score scale, so 0.9 does not mean 90 percent confidence. This setting does not affect Ask.", -1_000, 1_000, 0.01), "reranking"),
  panelSetting(positiveIntegerSetting("retrievalCandidates", "Search and answers", "Matching sections reviewed", "CiteLoom reviews up to this many matching sections before selecting the strongest source material.", "sections"), searchSizePanel),
  positiveIntegerSetting("findSourcesResults", "Search and answers", "Documents displayed", "How many matching documents appear at once. Keyword results continue on additional pages. Similar-content results show up to this number.", "documents"),
  positiveIntegerSetting("findSourcesPassagesPerDocument", "Search and answers", "Excerpts shown per document", "How many matching excerpts appear inside each Find Sources document result. This changes only what Find Sources displays.", "excerpts"),
  selectSetting("generationSeedMode", "Search and answers", "Repeatable answers", "Choose whether compatible models should try to return the same wording for the same request.", [
    { label: "Stable", value: "stable" },
    { label: "Random", value: "random" },
  ]),
  panelSetting(numberSetting("denseWeight", "Search and answers", "Semantic similarity", "How strongly results expressing the same meaning as the question influence search order, even when they use different words.", 0.01, 100, 0.01), searchMatchingPanel),
  panelSetting(numberSetting("lexicalWeight", "Search and answers", "Exact-word matches", "How strongly results containing the same words, names, codes, or phrases as the question influence search order.", 0.01, 100, 0.01), searchMatchingPanel),
  panelSetting(numberSetting("rrfK", "Search and answers", "Repeated matches", "How strongly CiteLoom favors source sections found by more than one search method or query. Higher values favor repeated matches; lower values favor the highest-ranked individual matches.", 1, 1_000, 1), searchMatchingPanel),
  panelSetting(positiveIntegerSetting("topK", "Search and answers", "Sections available for answers", "Ask and Chat can use up to this many of the strongest sections. This cannot be higher than Matching sections reviewed.", "sections"), searchSizePanel),
  featureSetting(nullableSetting(
    "sttLanguage",
    "Speech input",
    "Language hint",
    "text",
    "A language hint that can improve transcription when the provider supports it.",
  ), "speechToText"),
  featureSetting(nullableSetting(
    "sttPrompt",
    "Speech input",
    "Vocabulary prompt",
    "text",
    "Words or phrases that help the model recognize names and specialist terms.",
  ), "speechToText"),
  featureSetting(numberSetting(
    "sttTimeoutSeconds",
    "Speech input",
    "Transcription timeout",
    "How long CiteLoom waits for a transcription.",
    1,
    300,
    1,
    "seconds",
  ), "speechToText"),
  featureSetting(numberSetting(
    "sttMaxAudioMegabytes",
    "Speech input",
    "Maximum audio size",
    "The largest microphone recording CiteLoom accepts.",
    1,
    25,
    1,
    "MB",
  ), "speechToText"),
  featureSetting(setting(
    "ttsPreloadEnabled",
    "Spoken answers",
    "Preload answer audio",
    "boolean",
    "Create answer audio in the background as soon as an answer finishes.",
  ), "textToSpeech"),
  featureSetting(numberSetting(
    "ttsSpeed",
    "Spoken answers",
    "Speech speed",
    "How quickly spoken answers play.",
    0.25,
    5,
    0.05,
  ), "textToSpeech"),
  featureSetting(numberSetting(
    "ttsTimeoutSeconds",
    "Spoken answers",
    "Speech generation timeout",
    "How long CiteLoom waits for answer audio.",
    1,
    300,
    1,
    "seconds",
  ), "textToSpeech"),
  numberSetting("maxDocumentMegabytes", "Document processing", "Maximum document size", "The largest document users can upload.", 1, 100, 1, "MB"),
  numberSetting("maxAttempts", "Document processing", "Document retry attempts", "How many times CiteLoom retries a failed document-processing step before stopping.", 1, 20, 1),
  numberSetting("retryBaseMs", "Document processing", "First retry delay", "How long CiteLoom waits before retrying document processing for the first time. Later retries wait longer.", 100, 3_600_000, 100, "ms"),
  numberSetting("workerConcurrency", "Document processing", "Documents processed at once", "How many documents each running CiteLoom service can process at the same time.", 1, 16, 1),
  numberSetting("backgroundProgressIntervalMs", "Document processing", "Maximum wait for document processing", "How long waiting document work can be delayed while Ask or Chat is using the configured AI services.", 100, 3_600_000, 100, "ms"),
  numberSetting("workerFallbackPollMs", "Document processing", "Waiting-document check interval", "How often CiteLoom checks for newly queued documents while no processing notices arrive.", 1_000, 300_000, 1_000, "ms"),
  setting("aiMetricsEnabled", "Usage diagnostics", "AI request diagnostics", "boolean", "Record AI request times and usage without saving questions or answers."),
];

export const runtimeSettingChangeExamples = {
  claimVerifierRuntimeName: "Rename it to “Local claim checker” to make health reports easier to read.",
  claimVerifierBaseUrl: "Point it to http://hhem:8080 when HHEM runs in the Compose network.",
  claimVerifierSupportThreshold: "Raise 0.50 to require stronger evidence, or lower it to mark more borderline claims as supported.",
  claimVerifierTimeoutSeconds: "Raise 120 to 180 if large citation batches time out.",
  answerTimeoutSeconds: "Raise 600 to 900 when a large local model needs more than 10 minutes to answer.",
  answerMaximumOutputTokens: "Raise this to allow longer answers, or lower it to keep answers shorter.",
  answerMinimumOutputTokens: "Set this to the smallest space that can hold a complete answer in your preferred format.",
  answerProviderSafetyMarginTokens: "Increase this if the provider reports that a request is too large even though the selected model should have enough room.",
  embeddingInputFormatId: "Select the text format required by the embedding model. Changing it requires reindexing.",
  embeddingDimensions: "Change 768 to 1024 only when the selected embedding model requires 1024. Changing this value requires reindexing.",
  embeddingSpaceId: "Set a stable name such as legal-v2 when you want to identify this search setup across restarts.",
  embeddingTimeoutSeconds: "Raise 600 to 900 when a local embedding request needs more than 10 minutes.",
  retrievalChunkTargetTokens: "Use 512 for focused document sections. Larger values keep more nearby text together but may make individual matches less precise.",
  retrievalWindowPolicy: "Keep document structure to preserve headings, paragraphs, and table rows within searchable sections.",
  summaryTimeoutSeconds: "Raise 21600 when table or image descriptions need more than six hours, up to a maximum of 86400.",
  queryExpansionTimeoutSeconds: "Raise 60 to 120 when creating additional search wording needs more than one minute.",
  doclingBaseUrl: "Point it to http://docling:5001 when Docling runs in the Compose network.",
  doclingApiKey: "Replace it after Docling rotates its key so document conversions keep working.",
  doclingDefaultServiceCapacity: "Raise 2 to 3 only when the default Docling service can safely convert three documents at once.",
  doclingTimeoutSeconds: "Raise 1800 to 2400 to give every conversion ten more minutes.",
  doclingMaxTimeoutSeconds: "Raise 43200 to 86400 to let very large PDFs run for up to 24 hours.",
  doclingPageTimeoutSeconds: "Raise 30 to 45 to give each PDF page 15 more seconds.",
  doclingMegabyteTimeoutSeconds: "Raise 60 to 90 to give each megabyte 30 more seconds.",
  doclingRequestTimeoutSeconds: "Raise 300 to 600 if uploads, status checks, or result downloads time out.",
  doclingPerformanceMetricsEnabled: "Turn this on to record conversion times and outcomes without storing document content.",
  doclingPerformanceMetricsRetentionDays: "Change 30 to 7 to keep one week of conversion history instead of one month.",
  doclingPdfBackend: "Try PyPDFium2 when a troublesome PDF does not parse correctly with Docling Parse.",
  doclingOcrEnabled: "Turn this off for text-only PDFs to skip OCR. Scanned pages may then be empty.",
  doclingTableStructureEnabled: "Turn this off for simple documents. Tables will keep less row and cell detail.",
  doclingTocEnabled: "Enable this for long documents with useful headings. Run `citeloom document-toc backfill` so existing documents can also use their headings during search.",
  doclingTableMode: "Choose Fast to reduce processing time when perfect cell structure matters less.",
  doclingSecondaryImageScale: "Raise 2 to 3 for sharper extracted pictures. Conversions will use more memory.",
  rerankDiscoveryMinimumScore: "Start at 0.9. Raise it to hide more semantic matches or lower it to show more. Check actual Find Sources results because every search ranking model uses its own score scale.",
  rerankTimeoutSeconds: "Raise 120 to 300 if sorting a large set of search results times out.",
  retrievalCandidates: "Higher values search more broadly and may find additional relevant content, but take longer. Matching sections reviewed must be equal to or greater than Sections available for answers.",
  findSourcesResults: "Raise 10 to display more matching documents at once. Keyword results continue on additional pages.",
  findSourcesPassagesPerDocument: "Raise 3 to show more matching excerpts inside each document result. This changes only the Find Sources display.",
  queryExpansions: "Set this to 0 to use only the original question. Higher values generate alternative searches that may find relevant content written differently.",
  queryExpansionTemperature: "Set this to 0 for the most repeatable expansions. Raise it to allow more variation in generated search wording.",
  answerTemperature: "Raise this for more varied Ask responses. Lower it for more repeatable responses.",
  chatTemperature: "Raise this for more varied Chat responses. Lower it for more repeatable responses.",
  generationSeedMode: "Stable asks compatible models for repeatable answers. Random allows the wording to vary. Some models ignore this setting.",
  denseWeight: "Raise this relative to Exact-word matches to favor results with similar meaning, even when their wording differs.",
  lexicalWeight: "Raise this relative to Semantic similarity to favor matching words, names, codes, and phrases.",
  originalQueryWeight: "Raise this relative to First expansion influence to favor results found using the original question.",
  expansionQueryWeight: "Raise this relative to Original question influence to favor results found using the first expansion.",
  expansionDecay: "Use 1 to give all expansions equal influence. Lower values progressively reduce the influence of later expansions.",
  rrfK: "Raise this to favor source sections found by more than one search method or query. Lower it to favor the highest-ranked individual matches.",
  topK: "Higher values give Ask and Chat more source material but may make answers less focused. Sections available for answers cannot be higher than Matching sections reviewed.",
  sttLanguage: "Set en to bias recognition toward English.",
  sttPrompt: "Add “CiteLoom, HHEM, Docling” to help the model recognize project names.",
  sttTimeoutSeconds: "Raise 60 to 120 if long recordings time out.",
  sttMaxAudioMegabytes: "Lower 10 to 5 to reject large recordings sooner and use less memory.",
  ttsPreloadEnabled: "Turn this on so audio is ready sooner, even when nobody presses play.",
  ttsSpeed: "Set 1.25 to play spoken answers 25 percent faster.",
  ttsTimeoutSeconds: "Raise 60 to 120 if long answers time out during speech generation.",
  maxDocumentMegabytes: "Lower 100 to reject oversized documents sooner and reduce storage and processing demand.",
  maxAttempts: "Raise 3 to 5 to keep retrying temporary document-processing failures.",
  retryBaseMs: "Raise 5 to 10 so the first retry waits ten seconds instead of five.",
  backgroundProgressIntervalMs: "Lower this value to reduce how long document processing waits while Ask or Chat is busy.",
  workerConcurrency: "Raise 2 to 4 to process up to four documents at once in each running CiteLoom service.",
  workerFallbackPollMs: "Lower 60 to 15 to check for waiting documents every 15 seconds while CiteLoom is idle.",
  aiMetricsEnabled: "Turn this on to record AI request times and usage without storing questions or answers.",
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
      "Sign in to OpenAI Codex before assigning a feature to it.",
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
    throw new Error("Unknown application setting.");
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
      `The selected search text format does not exist: ${id}.`,
    );
  }
  if (inputFormat.retiredAt !== null) {
    throw new SettingsValidationError(
      `The selected search text format is retired: ${inputFormat.name}.`,
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
  materializeChatSettings(next);
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
      readMutableFeatureOverrides(
        next,
        change.capability,
      ).modelOverride = null;
      if (
        change.capability === "answer"
        || change.capability === "chat"
        || change.capability === "embedding"
        || change.capability === "queryExpansion"
        || change.capability === "summarization"
      ) {
        readMutableModelFeatureOverrides(
          next,
          change.capability,
        ).contextCapacityTokensOverride = null;
      }
      if (
        change.capability === "answer"
        || change.capability === "chat"
        || change.capability === "queryExpansion"
        || change.capability === "summarization"
      ) {
        readMutableLanguageFeatureOverrides(
          next,
          change.capability,
        ).thinkingModeOverride = null;
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
  readMutableFeatureOverrides(settings, capability).modelOverride =
    configuration.modelOverride;
  if (
    configuration.capability === "answer"
    || configuration.capability === "chat"
    || configuration.capability === "embedding"
    || configuration.capability === "queryExpansion"
    || configuration.capability === "summarization"
  ) {
    readMutableModelFeatureOverrides(
      settings,
      configuration.capability,
    ).contextCapacityTokensOverride =
      configuration.contextCapacityTokensOverride;
  }
  if (
    configuration.capability === "answer"
    || configuration.capability === "chat"
    || configuration.capability === "queryExpansion"
    || configuration.capability === "summarization"
  ) {
    readMutableLanguageFeatureOverrides(
      settings,
      configuration.capability,
    ).thinkingModeOverride = configuration.thinkingModeOverride;
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
    chat: configureModelConnection(
      current.chat ?? current.answer,
      configuration.chat ?? configuration.answer,
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
    thinkingMode: configuration.thinkingMode,
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
    || (configuration.chat?.baseUrl ?? null) !== null
    || configuration.queryExpansion.baseUrl !== null
    || configuration.summarization.baseUrl !== null
  ) {
    throw new SettingsValidationError(
      "The OpenAI Codex device credential can only use the fixed ChatGPT Codex endpoint.",
    );
  }
}

function materializeChatSettings(settings: ProviderSettings): void {
  settings.routing.chat = settings.routing.chat ?? settings.routing.answer;
  settings.featureOverrides.chat = {
    ...(settings.featureOverrides.chat ?? settings.featureOverrides.answer),
  };
  for (const connection of Object.values(settings.connections)) {
    connection.chat = {
      ...(connection.chat ?? connection.answer),
    };
    connection.customAdapters.chat = connection.customAdapters.chat
      ?? connection.customAdapters.answer;
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
    readMutableChatConnection(connection).apiToken = null;
    connection.embedding.apiToken = null;
    connection.queryExpansion.apiToken = null;
    connection.reranking.apiToken = null;
    connection.speechToText.apiToken = null;
    connection.summarization.apiToken = null;
    connection.textToSpeech.apiToken = null;
    return;
  }
  if (target === "chat") {
    readMutableChatConnection(connection).apiToken = value;
    return;
  }
  connection[target].apiToken = value;
}

function readMutableFeatureOverrides(
  settings: ProviderSettings,
  capability: ProviderCapability,
): ProviderCapabilityFeatureOverrides {
  if (capability === "chat") {
    settings.featureOverrides.chat ??= {
      ...settings.featureOverrides.answer,
    };
    return settings.featureOverrides.chat;
  }
  return settings.featureOverrides[capability];
}

function readMutableModelFeatureOverrides(
  settings: ProviderSettings,
  capability:
    | "answer"
    | "chat"
    | "embedding"
    | "queryExpansion"
    | "summarization",
): ProviderModelFeatureOverrides {
  if (capability === "chat") {
    settings.featureOverrides.chat ??= {
      ...settings.featureOverrides.answer,
    };
    return settings.featureOverrides.chat;
  }
  return settings.featureOverrides[capability];
}

function readMutableLanguageFeatureOverrides(
  settings: ProviderSettings,
  capability: "answer" | "chat" | "queryExpansion" | "summarization",
): ProviderLanguageFeatureOverrides {
  if (capability === "chat") {
    settings.featureOverrides.chat ??= {
      ...settings.featureOverrides.answer,
    };
    return settings.featureOverrides.chat;
  }
  return settings.featureOverrides[capability];
}

function readMutableChatConnection(
  connection: ProviderConnection,
): ProviderModelConnection {
  connection.chat ??= { ...connection.answer };
  return connection.chat;
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

function panelSetting(
  definition: RuntimeSettingDefinition,
  panel: RuntimeSettingPanel,
): RuntimeSettingDefinition {
  return { ...definition, panel };
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
