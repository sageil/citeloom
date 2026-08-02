import type { RetrievalWindowPolicyContract } from "../retrieval/window-policy.js";
import type { EmbeddingInputFormatContract } from "../embedding/input-format-model.js";

export interface AppConfig {
  claimVerifier: ClaimVerifierConfig;
  inferenceMetrics: InferenceMetricsConfig;
  database: DatabaseConfig;
  docling: DoclingConfig;
  doclingServices: DoclingServiceInstanceConfig[];
  embeddingSpace: EmbeddingSpaceConfig;
  inference: InferenceConfig;
  maxDocumentBytes: number;
  retry: RetryConfig;
  retrieval: RetrievalConfig;
  scheduling: SchedulingConfig;
  settingsVersion: number;
  sourceDiscovery: SourceDiscoveryConfig;
  sourceContent: SourceContentConfig;
  speechToText: SpeechToTextConfig | null;
  textToSpeech: TextToSpeechConfig | null;
  worker: WorkerConfig;
}

export interface ProviderRuntimeConfig {
  apiToken: string | null;
  baseUrl: string;
  providerId: string;
  runtimeName: string;
}

export type LanguageModelAdapter =
  | "cohere-language"
  | "deepseek-language"
  | "ollama-language"
  | "openai-codex-language"
  | "openai-compatible-language";

export type LanguageThinkingMode = "auto" | "disabled" | "enabled";

export type EmbeddingModelAdapter =
  | "cohere-embedding"
  | "ollama-embedding"
  | "openai-compatible-embedding";

export interface LanguageInferenceConfig extends ProviderRuntimeConfig {
  adaptiveContextEnabled: boolean;
  adapter: LanguageModelAdapter;
  contextCapacityTokens: number;
  model: string;
  thinkingMode: LanguageThinkingMode;
  timeoutMs: number;
}

export interface EmbeddingInferenceConfig extends ProviderRuntimeConfig {
  adapter: EmbeddingModelAdapter;
  inputFormat: EmbeddingInputFormatContract;
  maximumInputTokens: number;
  model: string;
  timeoutMs: number;
}

export interface ClaimVerifierConfig {
  baseUrl: string;
  model: string;
  runtimeName: string;
  supportThreshold: number;
  timeoutMs: number;
}

export interface InferenceMetricsConfig {
  enabled: boolean;
}

export interface ApplicationErrorRetentionConfig {
  maximumRows: number;
  retentionDays: number;
}

export interface DatabaseConfig {
  poolMax: number;
  url: string;
}

export interface SourceContentConfig {
  directory: string;
}

export type EmbeddingDimensions = 384 | 768 | 1024;

export interface EmbeddingSpaceConfig {
  dimensions: EmbeddingDimensions;
  id: string;
  inputFormat: EmbeddingInputFormatContract;
  model: string;
  retrievalWindow: RetrievalWindowPolicyContract;
}

export type ScheduledProviderCapability =
  | "answer"
  | "chat"
  | "embedding"
  | "queryExpansion"
  | "reranking"
  | "speechToText"
  | "summarization"
  | "textToSpeech";

export type WorkloadClass =
  | "offline-tool"
  | "ingestion"
  | "interactive-answer"
  | "interactive-search"
  | "maintenance";

export interface ProviderConcurrencyConfig {
  maximumParallelRequests: number;
  name: string;
  providerId: string;
}

export interface ScheduledProviderCapabilityConfig {
  providerId: string;
}

export interface SchedulingConfig {
  backgroundProgressIntervalMs: number;
  providers: ProviderConcurrencyConfig[];
  settingsVersion: number;
  targets: Partial<
    Record<ScheduledProviderCapability, ScheduledProviderCapabilityConfig>
  >;
  telemetryEnabled: boolean;
}

export interface InferenceConfig {
  answer: LanguageInferenceConfig;
  answerBudget: {
    maximumOutputTokens: number;
    minimumOutputTokens: number;
    providerSafetyMarginTokens: number;
  };
  chat: LanguageInferenceConfig;
  embedding: EmbeddingInferenceConfig;
  queryExpansion: LanguageInferenceConfig | null;
  summary: LanguageInferenceConfig;
}

export interface DoclingConfig {
  apiKey: string | null;
  baseTimeoutMs: number;
  baseUrl: string;
  maxTimeoutMs: number;
  megabyteTimeoutMs: number;
  ocrEnabled: boolean;
  pageTimeoutMs: number;
  pdfBackend: DoclingPdfBackend;
  performanceMetricsEnabled: boolean;
  performanceMetricsRetentionDays: number;
  requestTimeoutMs: number;
  secondaryImageScale: number;
  tableMode: DoclingTableMode;
  tableStructureEnabled: boolean;
  tocEnabled: boolean;
}

export interface DoclingProcessConfiguration {
  numThreads: number;
  pageBatchSize: number;
  profilePipelineTimings: boolean;
}

export interface DoclingServiceDeclaration {
  baseUrl: string;
  capacity: number;
  id: string;
}

export interface DoclingServiceTopology {
  additionalServices: DoclingServiceDeclaration[];
  process: DoclingProcessConfiguration;
}

export interface DoclingServiceInstanceConfig {
  baseUrl: string;
  capacity: number;
  id: string;
  process: DoclingProcessConfiguration;
}

export type DoclingPdfBackend =
  | "docling_parse"
  | "pypdfium2"
  | "threaded_docling_parse";

export type DoclingTableMode = "accurate" | "fast";

export interface RetryConfig {
  baseDelayMs: number;
  maxAttempts: number;
}

export interface RerankerConfig extends ProviderRuntimeConfig {
  adapter: RerankerAdapter;
  discoveryMinimumScore: number;
  model: string;
  timeoutMs: number;
}

export type RerankerAdapter = "top-n-rerank";

export type SpeechToTextAdapter =
  | "omlx-transcription"
  | "openai-transcription";

export type TextToSpeechAdapter =
  | "groq-speech"
  | "omlx-speech"
  | "openai-speech";

export interface TextToSpeechConfig extends ProviderRuntimeConfig {
  adapter: TextToSpeechAdapter;
  model: string;
  preload: boolean;
  speed: number;
  timeoutMs: number;
  voice: string;
}

export interface SpeechToTextConfig extends ProviderRuntimeConfig {
  adapter: SpeechToTextAdapter;
  language: string | null;
  maxAudioBytes: number;
  model: string;
  prompt: string | null;
  timeoutMs: number;
}

export type RetrievalMode =
  | "bm25"
  | "dense"
  | "hybrid"
  | "hybrid-reranked";

export interface RankFusionConfig {
  denseWeight: number;
  expansionDecay: number;
  expansionQueryWeight: number;
  lexicalWeight: number;
  originalQueryWeight: number;
}

export interface RetrievalConfig {
  answerTemperature: number;
  candidateK: number;
  chatTemperature: number;
  fusion: RankFusionConfig;
  generationSeedMode: "random" | "stable";
  mode: RetrievalMode;
  queryExpansionTemperature: number;
  queryExpansions: number;
  reranker: RerankerConfig | null;
  rrfK: number;
  topK: number;
}

export interface SourceDiscoveryConfig {
  passagesPerDocument: number;
  resultsPerGroup: number;
}

export interface WorkerConfig {
  concurrency: number;
  fallbackPollIntervalMs: number;
}

export interface RuntimeSettings {
  answerMaximumOutputTokens: number;
  answerMinimumOutputTokens: number;
  answerProviderSafetyMarginTokens: number;
  answerTemperature: number;
  answerTimeoutSeconds: number;
  aiMetricsEnabled: boolean;
  backgroundProgressIntervalMs: number;
  claimVerifierBaseUrl: string;
  claimVerifierRuntimeName: string;
  claimVerifierSupportThreshold: number;
  claimVerifierTimeoutSeconds: number;
  chatTemperature: number;
  denseWeight: number;
  doclingApiKey: string | null;
  doclingBaseUrl: string;
  doclingMaxTimeoutSeconds: number;
  doclingMegabyteTimeoutSeconds: number;
  doclingOcrEnabled: boolean;
  doclingPageTimeoutSeconds: number;
  doclingPdfBackend: DoclingPdfBackend;
  doclingPerformanceMetricsEnabled: boolean;
  doclingPerformanceMetricsRetentionDays: number;
  doclingSecondaryImageScale: number;
  doclingTableMode: DoclingTableMode;
  doclingTableStructureEnabled: boolean;
  doclingTocEnabled: boolean;
  doclingDefaultServiceCapacity: number;
  doclingRequestTimeoutSeconds: number;
  doclingTimeoutSeconds: number;
  embeddingDimensions: EmbeddingDimensions;
  embeddingInputFormatId: string;
  embeddingSpaceId: string | null;
  embeddingTimeoutSeconds: number;
  expansionDecay: number;
  expansionQueryWeight: number;
  findSourcesPassagesPerDocument: number;
  findSourcesResults: number;
  generationSeedMode: "random" | "stable";
  lexicalWeight: number;
  maxAttempts: number;
  maxDocumentMegabytes: number;
  originalQueryWeight: number;
  queryExpansions: number;
  queryExpansionTemperature: number;
  rerankDiscoveryMinimumScore: number;
  rerankTimeoutSeconds: number;
  retrievalCandidates: number;
  retrievalChunkTargetTokens: number;
  retrievalWindowPolicy: "structured-token-v3";
  retryBaseMs: number;
  rrfK: number;
  summaryTimeoutSeconds: number;
  queryExpansionTimeoutSeconds: number;
  sttLanguage: string | null;
  sttMaxAudioMegabytes: number;
  sttPrompt: string | null;
  sttTimeoutSeconds: number;
  topK: number;
  ttsPreloadEnabled: boolean;
  ttsSpeed: number;
  ttsTimeoutSeconds: number;
  workerConcurrency: number;
  workerFallbackPollMs: number;
}

export type RuntimeSettingKey = keyof RuntimeSettings;
export type RuntimeSettingValue = RuntimeSettings[RuntimeSettingKey];
export type RuntimeSettingsOverrides = Partial<
  Record<RuntimeSettingKey, RuntimeSettingValue>
>;

export interface StartupConfig {
  database: DatabaseConfig;
  doclingTopology: DoclingServiceTopology;
}
