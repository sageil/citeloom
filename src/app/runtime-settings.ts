import { z } from "zod";

import {
  runtimeSettingsSchema,
  type RuntimeSettingKey,
  type RuntimeSettingValue,
} from "../config/index.js";
import { SUPPORTED_EMBEDDING_DIMENSIONS } from "../embedding/dimensions.js";
import { isWorkspaceProviderCapability } from "../providers/profiles.js";
import {
  featureSetting,
  nullableSetting,
  numberSetting,
  panelSetting,
  positiveIntegerSetting,
  selectSetting,
  sensitiveSetting,
  setting,
  workspaceSetting,
  type RuntimeSettingDefinition,
  type RuntimeSettingPanel,
} from "./runtime-setting-definition.js";

export type {
  RuntimeSettingDefinition,
  RuntimeSettingGroup,
  RuntimeSettingInput,
  RuntimeSettingOption,
  RuntimeSettingPanel,
} from "./runtime-setting-definition.js";

const runtimeSettingKeySchema = z.enum([
  "applicationErrorMaximumRows",
  "applicationErrorRetentionDays",
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
  "doclingAdditionalServiceInstances",
  "doclingBaseUrl",
  "doclingMaxTimeoutSeconds",
  "doclingMegabyteTimeoutSeconds",
  "doclingNumThreads",
  "doclingOcrEnabled",
  "doclingPageTimeoutSeconds",
  "doclingPdfBackend",
  "doclingPerformanceMetricsEnabled",
  "doclingPerformanceMetricsRetentionDays",
  "doclingPipeline",
  "doclingPageBatchSize",
  "doclingProfilePipelineTimings",
  "doclingQueueMaxSize",
  "doclingSecondaryImageScale",
  "doclingServeEngineWorkers",
  "doclingServeShareModels",
  "doclingTableMode",
  "doclingTableStructureEnabled",
  "doclingTocEnabled",
  "doclingDefaultServiceCapacity",
  "doclingRequestTimeoutSeconds",
  "doclingTimeoutSeconds",
  "doclingVlmMaxOutputTokens",
  "doclingVlmModelOverride",
  "doclingVlmPrompt",
  "doclingVlmProviderId",
  "embeddingDimensions",
  "embeddingInputFormatId",
  "embeddingSpaceId",
  "embeddingTimeoutSeconds",
  "expansionDecay",
  "expansionQueryWeight",
  "findSourcesPassagesPerDocument",
  "findSourcesResults",
  "databasePoolMax",
  "hhemMaxAttentionCells",
  "hhemMaxPaddedTokens",
  "hhemModelBatchSize",
  "hhemTorchThreads",
  "lexicalWeight",
  "maxAttempts",
  "maxDocumentMegabytes",
  "maxUploadRequestMegabytes",
  "mcpTaskRetentionDays",
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
  "publicOrigin",
  "searchMethod",
  "secureSessionCookie",
  "indexingTimeoutSeconds",
  "sttLanguage",
  "sttMaxAudioMegabytes",
  "sttPrompt",
  "sttTimeoutSeconds",
  "topK",
  "ttsPreloadEnabled",
  "ttsSpeed",
  "ttsTimeoutSeconds",
  "trustProxy",
  "workerConcurrency",
  "workerFallbackPollMs",
]);

export const runtimeSettingKeys: readonly RuntimeSettingKey[] =
  runtimeSettingKeySchema.options;

const searchMatchingPanel: RuntimeSettingPanel = {
  description: "Choose whether CiteLoom searches by matching words, similar meaning, or both.",
  id: "search-matching",
  label: "Search matching",
};

const searchSizePanel: RuntimeSettingPanel = {
  description: "Choose how broadly CiteLoom searches your documents and how much of the strongest matching content Ask and Chat can use.",
  id: "search-size",
  label: "Search size",
};

const doclingConnectionPanel: RuntimeSettingPanel = {
  description: "Configure the Docling service connection and document concurrency.",
  id: "docling-connection",
  label: "Connection",
};

const doclingPdfProcessingPanel: RuntimeSettingPanel = {
  description: "Choose how Docling reads PDFs and extracts their content.",
  id: "docling-pdf-processing",
  label: "PDF processing",
};

const doclingPerformancePanel: RuntimeSettingPanel = {
  description: "Control conversion time allowances and limits.",
  id: "docling-performance",
  label: "Performance and limits",
};

const doclingDiagnosticsPanel: RuntimeSettingPanel = {
  description: "Control conversion diagnostics and retention.",
  id: "docling-diagnostics",
  label: "Diagnostics",
};

const hhemServiceProcessPanel: RuntimeSettingPanel = {
  description: "Control the HHEM service process. Restart the HHEM service after saving changes in this panel.",
  id: "hhem-service-process",
  label: "Service process",
};

const embeddingDimensionOptions = SUPPORTED_EMBEDDING_DIMENSIONS.map(
  (dimensions) => {
    return { label: String(dimensions), value: dimensions };
  },
);

export const runtimeSettingDefinitions: readonly RuntimeSettingDefinition[] = [
  setting("claimVerifierRuntimeName", "Hughes Hallucination Evaluation Model", "Citation checker name", "text", "The name shown for the service that checks whether citations support an answer."),
  setting("claimVerifierBaseUrl", "Hughes Hallucination Evaluation Model", "Citation checker address", "url", "The address of the service that checks whether citations support an answer."),
  workspaceSetting(numberSetting("claimVerifierSupportThreshold", "Hughes Hallucination Evaluation Model", "Supported citation score", "The lowest score CiteLoom shows as supported. The recommended value is 0.70.", 0, 1, 0.01)),
  numberSetting("claimVerifierTimeoutSeconds", "Hughes Hallucination Evaluation Model", "Citation check timeout", "How long CiteLoom waits for citation checks to finish.", 1, 3_600, 1, "seconds"),
  panelSetting(numberSetting("hhemMaxPaddedTokens", "Hughes Hallucination Evaluation Model", "Maximum padded tokens", "The maximum padded token count accepted by one HHEM request.", 1, 1_000_000, 1, "tokens"), hhemServiceProcessPanel),
  panelSetting(numberSetting("hhemMaxAttentionCells", "Hughes Hallucination Evaluation Model", "Maximum attention cells", "The maximum attention work accepted by one HHEM request.", 1, 100_000_000, 1, "cells"), hhemServiceProcessPanel),
  panelSetting(numberSetting("hhemModelBatchSize", "Hughes Hallucination Evaluation Model", "Model batch size", "The maximum number of citation pairs HHEM evaluates in one model batch.", 1, 64, 1, "pairs"), hhemServiceProcessPanel),
  panelSetting(numberSetting("hhemTorchThreads", "Hughes Hallucination Evaluation Model", "Torch threads", "The CPU thread count used by HHEM model inference.", 1, 256, 1, "threads"), hhemServiceProcessPanel),
  featureSetting(numberSetting("answerTemperature", "Hughes Hallucination Evaluation Model", "Temperature", "How much Ask responses may vary between runs.", 0, 2, 0.01), "answer"),
  featureSetting(numberSetting("answerTimeoutSeconds", "Hughes Hallucination Evaluation Model", "Answer timeout", "How long CiteLoom waits for an answer to finish.", 1, 3_600, 1, "seconds"), "answer"),
  featureSetting(numberSetting("answerMinimumOutputTokens", "Hughes Hallucination Evaluation Model", "Minimum answer space", "The space CiteLoom requires before starting an answer. If less space is available, the request stops instead of returning a cut-off answer.", 1, 262_144, 1, "tokens"), "answer"),
  featureSetting(numberSetting("answerProviderSafetyMarginTokens", "Hughes Hallucination Evaluation Model", "Reserved model space", "Space kept free so the selected provider can add its required instructions without exceeding the model limit.", 0, 262_144, 1, "tokens"), "answer"),
  featureSetting(numberSetting("chatTemperature", "Hughes Hallucination Evaluation Model", "Temperature", "How much Chat responses may vary between runs.", 0, 2, 0.01), "chat"),
  featureSetting(selectSetting("embeddingDimensions", "Embedding space", "Vector dimensions", "The application-wide vector size stored and searched in this embedding space.", embeddingDimensionOptions), "embedding"),
  featureSetting(selectSetting("embeddingInputFormatId", "Embedding space", "Search text format", "The application-wide text format used for document and query embeddings in this space.", []), "embedding"),
  featureSetting(selectSetting("retrievalWindowPolicy", "Embedding space", "Document section method", "How CiteLoom keeps nearby document content together for search.", [
    { label: "Keep document structure", value: "structured-token-v3" },
  ]), "embedding"),
  featureSetting(positiveIntegerSetting("retrievalChunkTargetTokens", "Embedding space", "Document section size", "The preferred size of searchable document sections. Smaller values create more focused sections, while larger values keep more nearby text together.", "tokens"), "embedding"),
  featureSetting(numberSetting("embeddingTimeoutSeconds", "Embedding space", "Embedding timeout", "How long CiteLoom waits while indexing documents or searching.", 1, 86_400, 1, "seconds"), "embedding"),
  featureSetting(nullableSetting("embeddingSpaceId", "Embedding space", "Search index name", "text", "An optional name for this search setup. Leave it blank to let CiteLoom choose one."), "embedding"),
  featureSetting(numberSetting("indexingTimeoutSeconds", "Document processing", "Indexing model timeout", "How long CiteLoom waits for the indexing model while preparing document content for search.", 1, 86_400, 1, "seconds"), "indexing"),
  featureSetting(numberSetting("queryExpansions", "Search and answers", "Number of expansions", "How many alternative searches CiteLoom may create for one question. Set this to 0 to search only the original wording.", 0, 4, 1), "queryExpansion"),
  featureSetting(numberSetting("queryExpansionTemperature", "Search and answers", "Temperature", "How much generated search wording may vary. Set this to 0 for the most repeatable wording.", 0, 2, 0.01), "queryExpansion"),
  featureSetting(numberSetting("originalQueryWeight", "Search and answers", "Original question influence", "How strongly results found using the original question affect the final search order compared with query expansions.", 0.01, 100, 0.01), "queryExpansion"),
  featureSetting(numberSetting("expansionQueryWeight", "Search and answers", "First expansion influence", "How strongly results found using the first query expansion affect the final search order compared with the original question.", 0.01, 100, 0.01), "queryExpansion"),
  featureSetting(numberSetting("expansionDecay", "Search and answers", "Later expansion influence", "How much influence each later expansion keeps from the expansion before it. A value of 1 gives every expansion equal influence; lower values reduce the influence of later expansions.", 0.01, 1, 0.01), "queryExpansion"),
  featureSetting(numberSetting("queryExpansionTimeoutSeconds", "Search and answers", "Timeout", "How long CiteLoom waits for query expansions before stopping the request.", 1, 3_600, 1, "seconds"), "queryExpansion"),
  panelSetting(setting("doclingBaseUrl", "Docling", "Docling base URL", "url", "Where CiteLoom sends documents for conversion."), doclingConnectionPanel),
  panelSetting(sensitiveSetting("doclingApiKey", "Docling", "Docling API key", "The secret CiteLoom uses to sign in to Docling."), doclingConnectionPanel),
  panelSetting(numberSetting("doclingDefaultServiceCapacity", "Docling", "Documents converted at once", "How many documents Docling can convert at the same time.", 1, 16, 1), doclingConnectionPanel),
  panelSetting(setting("doclingAdditionalServiceInstances", "Docling", "Additional Docling services", "json", "A JSON list of additional Docling services, each with a unique id, baseUrl, and capacity."), doclingConnectionPanel),
  panelSetting(selectSetting("doclingPipeline", "Docling", "Processing mode", "Choose Standard for Docling's layout, OCR, and table models, or VLM to read each page visually.", [
    { label: "Standard", value: "standard" },
    { label: "VLM", value: "vlm" },
  ]), doclingPdfProcessingPanel),
  panelSetting(selectSetting("doclingVlmProviderId", "Docling", "VLM provider", "Choose an existing provider connection for visual page processing.", []), doclingPdfProcessingPanel),
  panelSetting(nullableSetting("doclingVlmModelOverride", "Docling", "VLM model override", "text", "Use this model instead of the selected provider's default model."), doclingPdfProcessingPanel),
  panelSetting(setting("doclingVlmPrompt", "Docling", "VLM instructions", "text", "The task instructions sent with every PDF page."), doclingPdfProcessingPanel),
  panelSetting(numberSetting("doclingVlmMaxOutputTokens", "Docling", "VLM output limit", "The most output the VLM may return for one PDF page.", 1, 262_144, 1, "tokens"), doclingPdfProcessingPanel),
  panelSetting(selectSetting("doclingPdfBackend", "Docling", "PDF reader", "The PDF reader used by Standard processing.", [
    { label: "Docling Parse", value: "docling_parse" },
    { label: "Threaded Docling Parse", value: "threaded_docling_parse" },
    { label: "PyPDFium2", value: "pypdfium2" },
  ]), doclingPdfProcessingPanel),
  panelSetting(setting("doclingOcrEnabled", "Docling", "Read scanned text", "boolean", "Use OCR for scanned pages and images in Standard processing."), doclingPdfProcessingPanel),
  panelSetting(setting("doclingTableStructureEnabled", "Docling", "Preserve table structure", "boolean", "Detect rows, columns, and merged cells in tables during Standard processing."), doclingPdfProcessingPanel),
  panelSetting(selectSetting("doclingTableMode", "Docling", "Table reading priority", "Choose whether Standard table reading favors accuracy or speed.", [
    { label: "Accurate", value: "accurate" },
    { label: "Fast", value: "fast" },
  ]), doclingPdfProcessingPanel),
  panelSetting(numberSetting("doclingSecondaryImageScale", "Docling", "Extracted image quality", "How sharp extracted page and picture images should be. Higher values use more memory.", 0.1, 8, 0.1), doclingPdfProcessingPanel),
  panelSetting(setting(
    "doclingTocEnabled",
    "Docling",
    "Use document headings in search",
    "boolean",
    "Use a document's headings to help Ask and Chat find relevant sections in long documents. Run the documented update command so existing documents also benefit.",
  ), doclingPdfProcessingPanel),
  panelSetting(numberSetting("doclingTimeoutSeconds", "Docling", "Standard conversion time", "The time allowed for every document before page and file-size allowances are added.", 60, 604_800, 1, "seconds"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingMaxTimeoutSeconds", "Docling", "Maximum conversion time", "The longest CiteLoom waits for one document conversion.", 60, 604_800, 1, "seconds"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingPageTimeoutSeconds", "Docling", "Extra time per PDF page", "The conversion time added for each PDF page.", 0, 3_600, 1, "seconds"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingMegabyteTimeoutSeconds", "Docling", "Extra time per megabyte", "The conversion time added for each megabyte in a document.", 0, 3_600, 1, "seconds"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingRequestTimeoutSeconds", "Docling", "Docling connection timeout", "How long CiteLoom waits while sending a document to Docling, checking progress, or downloading the result.", 10, 3_600, 1, "seconds"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingNumThreads", "Docling", "Docling threads", "The CPU thread count used by the Docling process. Restart Docling after saving this value.", 1, 1_024, 1, "threads"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingPageBatchSize", "Docling", "Page batch size", "The number of pages Docling processes in one batch. Restart Docling after saving this value.", 1, 1_024, 1, "pages"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingQueueMaxSize", "Docling", "Service queue size", "The maximum number of waiting Docling conversion requests. Restart Docling after saving this value.", 1, 10_000, 1, "requests"), doclingPerformancePanel),
  panelSetting(numberSetting("doclingServeEngineWorkers", "Docling", "Engine workers", "The number of local engine workers used by Docling Serve. Restart Docling after saving this value.", 1, 64, 1, "workers"), doclingPerformancePanel),
  panelSetting(setting("doclingServeShareModels", "Docling", "Share models between workers", "boolean", "Share loaded Docling models between local engine workers. Restart Docling after saving this value."), doclingPerformancePanel),
  panelSetting(setting("doclingPerformanceMetricsEnabled", "Docling", "Conversion diagnostics", "boolean", "Save conversion times and outcomes without saving document content."), doclingDiagnosticsPanel),
  panelSetting(numberSetting("doclingPerformanceMetricsRetentionDays", "Docling", "Conversion history", "How long CiteLoom keeps completed conversion diagnostics.", 1, 3_650, 1, "days"), doclingDiagnosticsPanel),
  panelSetting(setting("doclingProfilePipelineTimings", "Docling", "Profile pipeline timings", "boolean", "Collect detailed Docling pipeline timing diagnostics. Restart Docling after saving this value."), doclingDiagnosticsPanel),
  featureSetting(numberSetting("rerankTimeoutSeconds", "Search ranking", "Search ranking timeout", "How long CiteLoom waits for semantic search results to be sorted.", 1, 3_600, 1, "seconds"), "reranking"),
  featureSetting(numberSetting("rerankDiscoveryMinimumScore", "Search ranking", "Minimum score for Find Sources", "The lowest semantic-match score Find Sources shows. Higher values show fewer matches. Each search ranking model uses its own score scale, so 0.9 does not mean 90 percent confidence. This setting does not affect Ask.", -1_000, 1_000, 0.01), "reranking"),
  workspaceSetting(panelSetting(positiveIntegerSetting("retrievalCandidates", "Search and answers", "Matching sections reviewed", "CiteLoom collects up to this many unique matching sections before reranking them. Lower values can miss relevant evidence, while higher values search more broadly but take longer.", "sections"), searchSizePanel)),
  workspaceSetting(positiveIntegerSetting("findSourcesResults", "Search and answers", "Documents displayed", "How many matching documents appear at once. Keyword results continue on additional pages. Similar-content results show up to this number.", "documents")),
  workspaceSetting(positiveIntegerSetting("findSourcesPassagesPerDocument", "Search and answers", "Excerpts shown per document", "How many matching excerpts appear inside each Find Sources document result. This changes only what Find Sources displays.", "excerpts")),
  workspaceSetting(panelSetting(selectSetting("searchMethod", "Search and answers", "Search method", "Choose how CiteLoom finds document sections for Ask and Chat.", [
    { label: "Hybrid - Recommended", value: "hybrid" },
    { label: "Keyword", value: "bm25" },
    { label: "Semantic", value: "dense" },
  ]), searchMatchingPanel)),
  workspaceSetting(panelSetting(numberSetting("denseWeight", "Search and answers", "Semantic similarity", "How strongly results expressing the same meaning as the question influence search order, even when they use different words.", 0.01, 100, 0.01), searchMatchingPanel)),
  workspaceSetting(panelSetting(numberSetting("lexicalWeight", "Search and answers", "Exact-word matches", "How strongly results containing the same words, names, codes, or phrases as the question influence search order.", 0.01, 100, 0.01), searchMatchingPanel)),
  workspaceSetting(panelSetting(numberSetting("rrfK", "Search and answers", "Repeated matches", "How strongly CiteLoom favors source sections found by more than one search method or query. Higher values favor repeated matches; lower values favor the highest-ranked individual matches.", 1, 1_000, 1), searchMatchingPanel)),
  workspaceSetting(panelSetting(positiveIntegerSetting("topK", "Search and answers", "Sections available for answers", "After reranking, Ask and Chat can send up to this many sections to the answer model. Lower values can omit needed evidence; higher values increase model input, response time, and distraction risk. CiteLoom may use fewer when the remaining matches are substantially weaker. This cannot be higher than Matching sections reviewed.", "sections"), searchSizePanel)),
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
  numberSetting("maxUploadRequestMegabytes", "Web server", "Maximum upload request size", "The largest complete upload request accepted by the web server. Restart the web service after saving this value.", 1, 100, 1, "MB"),
  numberSetting("maxAttempts", "Document processing", "Document retry attempts", "How many times CiteLoom retries a failed document-processing step before stopping.", 1, 20, 1),
  numberSetting("retryBaseMs", "Document processing", "First retry delay", "How long CiteLoom waits before retrying document processing for the first time. Later retries wait longer.", 100, 3_600_000, 100, "ms"),
  numberSetting("workerConcurrency", "Document processing", "Documents processed at once", "How many documents each running CiteLoom service can process at the same time.", 1, 16, 1),
  numberSetting("backgroundProgressIntervalMs", "Document processing", "Maximum wait for document processing", "How long waiting document work can be delayed while Ask or Chat is using the configured AI services.", 100, 3_600_000, 100, "ms"),
  numberSetting("workerFallbackPollMs", "Document processing", "Waiting-document check interval", "How often CiteLoom checks for newly queued documents while no processing notices arrive.", 1_000, 300_000, 1_000, "ms"),
  numberSetting("mcpTaskRetentionDays", "MCP", "Task retention", "How long CiteLoom keeps completed, failed, and cancelled MCP tasks before removing them.", 1, 3_650, 1, "days"),
  numberSetting("databasePoolMax", "Database", "Maximum database connections", "The maximum database connections kept by each web or worker process. Restart web and worker services after saving this value.", 1, 100, 1, "connections"),
  setting("publicOrigin", "Web server", "Public origin", "url", "The public browser origin for authentication and origin checks. Restart the web service after saving this value."),
  setting("secureSessionCookie", "Web server", "Secure session cookie", "boolean", "Send session cookies only over HTTPS. Restart the web service after saving this value."),
  setting("trustProxy", "Web server", "Trust reverse proxy", "boolean", "Trust proxy-provided client connection information. Enable this only behind a trusted proxy, then restart the web service."),
  numberSetting("applicationErrorMaximumRows", "Usage diagnostics", "Maximum application error rows", "The maximum number of application error records retained.", 1, 10_000_000, 1, "rows"),
  numberSetting("applicationErrorRetentionDays", "Usage diagnostics", "Application error retention", "How long CiteLoom retains application error records.", 1, 3_650, 1, "days"),
  setting("aiMetricsEnabled", "Usage diagnostics", "AI request diagnostics", "boolean", "Record AI request times and usage without saving questions or answers."),
];

export const runtimeSettingChangeExamples = {
  applicationErrorMaximumRows: "Lower 100000 to retain fewer application error records.",
  applicationErrorRetentionDays: "Change 30 to 7 to retain application errors for one week.",
  claimVerifierRuntimeName: "Rename it to “Local claim checker” to make health reports easier to read.",
  claimVerifierBaseUrl: "Point it to http://hhem:8080 when HHEM runs in the Compose network.",
  claimVerifierSupportThreshold: "Raise 0.70 to require stronger evidence, or lower it to mark more borderline claims as supported.",
  claimVerifierTimeoutSeconds: "Raise 120 to 180 if large citation batches time out.",
  answerTimeoutSeconds: "Raise 600 to 900 when a large local model needs more than 10 minutes to answer.",
  answerMinimumOutputTokens: "Set this to the smallest space that can hold a complete answer in your preferred format.",
  answerProviderSafetyMarginTokens: "Increase this if the provider reports that a request is too large even though the selected model should have enough room.",
  embeddingInputFormatId: "Select the application-wide text format for this embedding space. Changing it creates a new embedding space and requires reindexing.",
  embeddingDimensions: "Choose the application-wide vector size for this embedding space. Changing it creates a new embedding space and requires reindexing.",
  embeddingSpaceId: "Set a stable name such as legal-v2 when you want to identify this search setup across restarts.",
  embeddingTimeoutSeconds: "Raise 600 to 900 when a local embedding request needs more than 10 minutes.",
  retrievalChunkTargetTokens: "Use 512 for focused document sections. Larger values keep more nearby text together but may make individual matches less precise.",
  retrievalWindowPolicy: "Keep document structure to preserve headings, paragraphs, and table rows within searchable sections.",
  indexingTimeoutSeconds: "Raise 21600 when table or image descriptions need more than six hours, up to a maximum of 86400.",
  queryExpansionTimeoutSeconds: "Raise 60 to 120 when creating additional search wording needs more than one minute.",
  doclingBaseUrl: "Point it to http://docling:5001 when Docling runs in the Compose network.",
  doclingApiKey: "Replace it after Docling rotates its key so document conversions keep working.",
  doclingAdditionalServiceInstances: "Add [{\"id\":\"docling-2\",\"baseUrl\":\"http://docling-2:5001\",\"capacity\":2}] to distribute conversions to another service.",
  doclingDefaultServiceCapacity: "Raise 2 to 3 only when the default Docling service can safely convert three documents at once.",
  doclingTimeoutSeconds: "Raise 1800 to 2400 to give every conversion ten more minutes.",
  doclingMaxTimeoutSeconds: "Raise 43200 to 86400 to let very large PDFs run for up to 24 hours.",
  doclingPageTimeoutSeconds: "Raise 30 to 45 to give each PDF page 15 more seconds.",
  doclingMegabyteTimeoutSeconds: "Raise 60 to 90 to give each megabyte 30 more seconds.",
  doclingNumThreads: "Raise 4 to 8 when Docling has enough CPU capacity, then restart Docling.",
  doclingPageBatchSize: "Raise 4 to 8 to process more pages per batch, then restart Docling.",
  doclingProfilePipelineTimings: "Enable this while diagnosing conversion performance, then restart Docling.",
  doclingQueueMaxSize: "Raise 8 when Docling should accept more waiting conversions, then restart Docling.",
  doclingRequestTimeoutSeconds: "Raise 300 to 600 if uploads, status checks, or result downloads time out.",
  doclingPerformanceMetricsEnabled: "Turn this on to record conversion times and outcomes without storing document content.",
  doclingPerformanceMetricsRetentionDays: "Change 30 to 7 to keep one week of conversion history instead of one month.",
  doclingPipeline: "Choose VLM to have the selected vision model read each PDF page visually. New conversions use the selected mode.",
  doclingPdfBackend: "Try PyPDFium2 when a troublesome PDF does not parse correctly with Docling Parse.",
  doclingOcrEnabled: "Turn this off for text-only PDFs to skip OCR. Scanned pages may then be empty.",
  doclingTableStructureEnabled: "Turn this off for simple documents. Tables will keep less row and cell detail.",
  doclingTocEnabled: "Enable this for long documents with useful headings. Run `citeloom document-toc backfill` so existing documents can also use their headings during search.",
  doclingTableMode: "Choose Fast to reduce processing time when perfect cell structure matters less.",
  doclingSecondaryImageScale: "Raise 2 to 3 for sharper extracted pictures. Conversions will use more memory.",
  doclingServeEngineWorkers: "Raise 1 to 2 when Docling has enough memory and CPU, then restart Docling.",
  doclingServeShareModels: "Enable this to share models between Docling workers, then restart Docling.",
  doclingVlmModelOverride: "Enter any model name accepted by the selected provider, or leave this blank to use that provider's default answer model.",
  doclingVlmPrompt: "Use the activation text required by the selected model. Unlimited OCR uses `document parsing.` for a single page.",
  doclingVlmMaxOutputTokens: "Raise this when dense pages are cut off. The selected provider and model may enforce a lower limit.",
  doclingVlmProviderId: "Choose the provider connection Docling should call when VLM processing is enabled.",
  rerankDiscoveryMinimumScore: "Start at 0.9. Raise it to hide more semantic matches or lower it to show more. Check actual Find Sources results because every search ranking model uses its own score scale.",
  rerankTimeoutSeconds: "Raise 120 to 300 if sorting a large set of search results times out.",
  retrievalCandidates: "Keep this large enough to cover broad and multi-part questions. CiteLoom collapses exact duplicate evidence and keeps searching until it reaches this many unique candidates or exhausts the authorized scope. Higher values improve the opportunity to recover lower-ranked evidence but increase search and reranking work. Matching sections reviewed must be equal to or greater than Sections available for answers.",
  findSourcesResults: "Raise 10 to display more matching documents at once. Keyword results continue on additional pages.",
  findSourcesPassagesPerDocument: "Raise 3 to show more matching excerpts inside each document result. This changes only the Find Sources display.",
  databasePoolMax: "Raise 10 to 20 when PostgreSQL capacity and concurrent application work justify more connections, then restart web and worker services.",
  hhemMaxAttentionCells: "Lower 20000000 to reject expensive citation batches sooner, then restart HHEM.",
  hhemMaxPaddedTokens: "Lower 20000 to limit the padded token workload per request, then restart HHEM.",
  hhemModelBatchSize: "Lower 20 to reduce peak HHEM memory use, then restart HHEM.",
  hhemTorchThreads: "Set this to the CPU allocation available to HHEM, then restart HHEM.",
  queryExpansions: "Set this to 0 to use only the original question. Higher values generate alternative searches that may find relevant content written differently.",
  queryExpansionTemperature: "Set this to 0 for the most repeatable expansions. Raise it to allow more variation in generated search wording.",
  answerTemperature: "Raise this for more varied Ask responses. Lower it for more repeatable responses.",
  chatTemperature: "Raise this for more varied Chat responses. Lower it for more repeatable responses.",
  denseWeight: "Raise this relative to Exact-word matches to favor results with similar meaning, even when their wording differs.",
  lexicalWeight: "Raise this relative to Semantic similarity to favor matching words, names, codes, and phrases.",
  originalQueryWeight: "Raise this relative to First expansion influence to favor results found using the original question.",
  expansionQueryWeight: "Raise this relative to Original question influence to favor results found using the first expansion.",
  expansionDecay: "Use 1 to give all expansions equal influence. Lower values progressively reduce the influence of later expansions.",
  rrfK: "Raise this to favor source sections found by more than one search method or query. Lower it to favor the highest-ranked individual matches.",
  searchMethod: "Hybrid combines exact words with meaning-based matches. Keyword skips the document-query embedding call. Semantic searches by meaning only.",
  topK: "This is a ceiling after reranking, not the initial retrieval pool. Higher values give the answer model more source material but increase prompt size, response time, and distraction risk. CiteLoom may stop below this ceiling when the remaining matches are substantially weaker. Sections available for answers cannot be higher than Matching sections reviewed.",
  sttLanguage: "Set en to bias recognition toward English.",
  sttPrompt: "Add “CiteLoom, HHEM, Docling” to help the model recognize project names.",
  sttTimeoutSeconds: "Raise 60 to 120 if long recordings time out.",
  sttMaxAudioMegabytes: "Lower 10 to 5 to reject large recordings sooner and use less memory.",
  ttsPreloadEnabled: "Turn this on so audio is ready sooner, even when nobody presses play.",
  ttsSpeed: "Set 1.25 to play spoken answers 25 percent faster.",
  ttsTimeoutSeconds: "Raise 60 to 120 if long answers time out during speech generation.",
  maxDocumentMegabytes: "Lower 100 to reject oversized documents sooner and reduce storage and processing demand.",
  maxUploadRequestMegabytes: "Lower 100 to reject oversized upload requests sooner, then restart the web service.",
  mcpTaskRetentionDays: "Change 30 to 7 to keep completed MCP task results for one week.",
  maxAttempts: "Raise 3 to 5 to keep retrying temporary document-processing failures.",
  retryBaseMs: "Raise 5 to 10 so the first retry waits ten seconds instead of five.",
  publicOrigin: "Set this to the exact browser origin for this deployment, then restart the web service.",
  backgroundProgressIntervalMs: "Lower this value to reduce how long document processing waits while Ask or Chat is busy.",
  workerConcurrency: "Raise 2 to 4 to process up to four documents at once in each running CiteLoom service.",
  workerFallbackPollMs: "Lower 60 to 15 to check for waiting documents every 15 seconds while CiteLoom is idle.",
  secureSessionCookie: "Disable this only for a local HTTP deployment, then restart the web service.",
  trustProxy: "Enable this only when CiteLoom is behind a trusted reverse proxy, then restart the web service.",
  aiMetricsEnabled: "Turn this on to record AI request times and usage without storing questions or answers.",
} satisfies Record<RuntimeSettingKey, string>;

const definitionByKey = new Map(
  runtimeSettingDefinitions.map((definition) => [definition.key, definition]),
);
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

export function isWorkspaceRuntimeSetting(key: RuntimeSettingKey): boolean {
  const definition = definitionByKey.get(key);
  if (definition === undefined) {
    return false;
  }
  if (definition.workspaceConfigurable === true) {
    return true;
  }
  return definition.feature !== undefined
    && isWorkspaceProviderCapability(definition.feature);
}
function runtimeSettingsSchemaForKey(
  key: RuntimeSettingKey,
): z.ZodType<RuntimeSettingValue> {
  return runtimeSettingsSchema.shape[key] as z.ZodType<RuntimeSettingValue>;
}
