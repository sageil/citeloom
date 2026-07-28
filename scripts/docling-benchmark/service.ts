import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { promisify } from "node:util";

import { z } from "zod";

import type { DoclingConfig } from "../../src/config/index.js";
import {
  decodeDoclingCapabilities,
} from "../../src/docling/client/capabilities.js";
import { verifyDoclingService } from "../../src/docling/index.js";
import type {
  DoclingBenchmarkEnvironment,
  DoclingBenchmarkProcessConfiguration,
} from "./model.js";
import type {
  DoclingVersionIdentity,
} from "../../src/docling/protocol/index.js";
import { DOCLING_OCR_PRESET } from "../../src/docling/protocol/model.js";
import {
  calculateDoclingPrometheusDelta,
  decodeDoclingPrometheusMetrics,
  type DoclingPrometheusDelta,
  type DoclingPrometheusSnapshot,
} from "../../src/docling/observability/prometheus.js";

const executeFile = promisify(execFile);
const BENCHMARK_BASE_URL = "http://127.0.0.1:5002";
const COMPOSE_PROJECT = "citeloom-benchmark";
const COMPOSE_WRAPPER = "./scripts/docling-benchmark/compose.sh";
const DOCLING_IMAGE =
  "citeloom/docling-serve-cpu:1.27.0-ppocrv5-2d2fd797";
const OCR_MODEL_DIRECTORY = "/opt/app-root/src/citeloom-ocr-models";
const METRICS_SAMPLE_INTERVAL_MS = 500;
const commandOutputSchema = z.object({ stdout: z.string() }).loose();
const effectiveServiceConfigurationSchema = z.object({
  ocr: z.object({
    backend: z.literal("onnxruntime"),
    classifierModelPath: z.literal(
      `${OCR_MODEL_DIRECTORY}/ch_ppocr_mobile_v2.0_cls_infer.onnx`,
    ),
    defaultKind: z.literal(DOCLING_OCR_PRESET),
    defaultPreset: z.literal(DOCLING_OCR_PRESET),
    detectorModelPath: z.literal(
      `${OCR_MODEL_DIRECTORY}/ch_PP-OCRv5_server_det.onnx`,
    ),
    kind: z.literal(DOCLING_OCR_PRESET),
    maxSideLength: z.literal(1_000),
    recognitionKeysPath: z.literal(
      `${OCR_MODEL_DIRECTORY}/ppocrv5_dict.txt`,
    ),
    recognitionModelPath: z.literal(
      `${OCR_MODEL_DIRECTORY}/ch_PP-OCRv5_rec_server_infer.onnx`,
    ),
    unclipRatio: z.literal(1),
  }).strict(),
  process: z.object({
    batchPollingIntervalSeconds: z.number().positive(),
    layoutBatchSize: z.number().int().positive(),
    loadModelsAtBoot: z.boolean(),
    localModelsShared: z.boolean(),
    localWorkerCount: z.number().int().positive(),
    numThreads: z.number().int().positive(),
    ocrBatchSize: z.number().int().positive(),
    optionsCacheSize: z.number().int().positive(),
    profilePipelineTimings: z.boolean(),
    queueMaxSize: z.number().int().positive(),
    resultRemovalDelaySeconds: z.number().int().nonnegative(),
    singleUseResults: z.boolean(),
    tableBatchSize: z.number().int().positive(),
  }).strict(),
}).strict();
const EFFECTIVE_SERVICE_CONFIGURATION_PROBE = [
  "import json, os",
  "from docling.datamodel.settings import settings",
  "from docling_serve.settings import DoclingServeSettings",
  "serve_settings = DoclingServeSettings()",
  `preset = serve_settings.custom_ocr_presets['${DOCLING_OCR_PRESET}']`,
  "ocr = {}",
  "ocr['backend'] = preset['backend']",
  "ocr['classifierModelPath'] = preset['cls_model_path']",
  "ocr['defaultKind'] = serve_settings.default_ocr_kind",
  "ocr['defaultPreset'] = serve_settings.default_ocr_preset",
  "ocr['detectorModelPath'] = preset['det_model_path']",
  "ocr['kind'] = preset['kind']",
  "ocr['maxSideLength'] = preset['rapidocr_params']['Global.max_side_len']",
  "ocr['recognitionKeysPath'] = preset['rec_keys_path']",
  "ocr['recognitionModelPath'] = preset['rec_model_path']",
  "ocr['unclipRatio'] = preset['rapidocr_params']['Det.unclip_ratio']",
  "process = {}",
  "process['batchPollingIntervalSeconds'] = serve_settings.batch_polling_interval_seconds",
  "process['layoutBatchSize'] = serve_settings.layout_batch_size",
  "process['loadModelsAtBoot'] = serve_settings.load_models_at_boot",
  "process['localModelsShared'] = serve_settings.eng_loc_share_models",
  "process['localWorkerCount'] = serve_settings.eng_loc_num_workers",
  "process['numThreads'] = int(os.environ['DOCLING_NUM_THREADS'])",
  "process['ocrBatchSize'] = serve_settings.ocr_batch_size",
  "process['optionsCacheSize'] = serve_settings.options_cache_size",
  "process['profilePipelineTimings'] = settings.debug.profile_pipeline_timings",
  "process['queueMaxSize'] = serve_settings.queue_max_size",
  "process['resultRemovalDelaySeconds'] = serve_settings.result_removal_delay",
  "process['singleUseResults'] = serve_settings.single_use_results",
  "process['tableBatchSize'] = serve_settings.table_batch_size",
  "print(json.dumps({'ocr': ocr, 'process': process}))",
].join("; ");

export interface BenchmarkServiceCommand {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  executable: string;
}

export type BenchmarkServiceCommandRunner = (
  command: BenchmarkServiceCommand,
) => Promise<string>;

export interface DoclingBenchmarkServiceMeasurement {
  cpuTimeMs: number | null;
  httpRequestCount: number | null;
  httpRequestDurationMs: number | null;
  peakResidentBytes: number | null;
  statusPollRequestCount: number | null;
}

export type DoclingBenchmarkServiceEnvironment = Omit<
  DoclingBenchmarkEnvironment,
  "baseline" | "corpusFingerprint"
>;

export interface DoclingBenchmarkServiceDependencies {
  readJson(url: string): Promise<unknown>;
  verifyService(config: DoclingConfig): Promise<DoclingVersionIdentity>;
}

const defaultDependencies: DoclingBenchmarkServiceDependencies = {
  readJson,
  verifyService: verifyDoclingService,
};

export class DoclingBenchmarkService {
  private running = false;

  public constructor(
    private readonly commandRunner: BenchmarkServiceCommandRunner = runCommand,
    public readonly baseUrl: string = BENCHMARK_BASE_URL,
    private readonly dependencies: DoclingBenchmarkServiceDependencies =
      defaultDependencies,
  ) {}

  public async start(
    processConfig: DoclingBenchmarkProcessConfiguration,
  ): Promise<DoclingBenchmarkServiceEnvironment> {
    if (!processConfig.profilePipelineTimings) {
      throw new Error("The benchmark service requires pipeline profiling.");
    }
    await this.stop();
    const environment = {
      ...process.env,
      DOCLING_BENCHMARK_BATCH_POLLING_INTERVAL_SECONDS:
        String(processConfig.batchPollingIntervalSeconds),
      DOCLING_BENCHMARK_LAYOUT_BATCH_SIZE:
        String(processConfig.layoutBatchSize),
      DOCLING_BENCHMARK_LOAD_MODELS_AT_BOOT:
        String(processConfig.loadModelsAtBoot),
      DOCLING_BENCHMARK_LOCAL_MODELS_SHARED:
        String(processConfig.localModelsShared),
      DOCLING_BENCHMARK_LOCAL_WORKER_COUNT:
        String(processConfig.localWorkerCount),
      DOCLING_BENCHMARK_NUM_THREADS: String(processConfig.numThreads),
      DOCLING_BENCHMARK_OCR_BATCH_SIZE:
        String(processConfig.ocrBatchSize),
      DOCLING_BENCHMARK_OPTIONS_CACHE_SIZE:
        String(processConfig.optionsCacheSize),
      DOCLING_BENCHMARK_QUEUE_MAX_SIZE:
        String(processConfig.queueMaxSize),
      DOCLING_BENCHMARK_RESULT_REMOVAL_DELAY_SECONDS:
        String(processConfig.resultRemovalDelaySeconds),
      DOCLING_BENCHMARK_SINGLE_USE_RESULTS:
        String(processConfig.singleUseResults),
      DOCLING_BENCHMARK_TABLE_BATCH_SIZE:
        String(processConfig.tableBatchSize),
    };
    await this.commandRunner({
      arguments: [
        "up",
        "-d",
        "--wait",
        "docling-benchmark",
      ],
      environment,
      executable: COMPOSE_WRAPPER,
    });
    this.running = true;
    try {
      const effectiveConfiguration = await this.readEffectiveConfiguration(
        environment,
      );
      if (!sameProcessConfiguration(effectiveConfiguration.process, processConfig)) {
        throw new Error(
          "The isolated Docling service did not apply its requested process configuration.",
        );
      }
      const config = createBenchmarkDoclingConfig(this.baseUrl);
      const [service, openApi] = await Promise.all([
        this.dependencies.verifyService(config),
        this.dependencies.readJson(`${this.baseUrl}/openapi.json`),
      ]);
      const capabilities = decodeDoclingCapabilities(openApi);
      return {
        baseUrl: this.baseUrl,
        capabilitiesFingerprint: capabilities.fingerprint,
        composeProject: COMPOSE_PROJECT,
        cpuCount: availableParallelism(),
        imageReference: DOCLING_IMAGE,
        ocrPreset: effectiveConfiguration.ocr.defaultPreset,
        process: processConfig,
        service,
      };
    } catch (error: unknown) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    await this.commandRunner({
      arguments: ["stop", "docling-benchmark"],
      environment: process.env,
      executable: COMPOSE_WRAPPER,
    });
    this.running = false;
  }

  public async beginMeasurement(): Promise<DoclingServiceMeasurement> {
    if (!this.running) {
      throw new Error("The benchmark service is not running.");
    }
    return DoclingServiceMeasurement.start(this.baseUrl);
  }

  private async readEffectiveConfiguration(
    environment: NodeJS.ProcessEnv,
  ): Promise<z.infer<typeof effectiveServiceConfigurationSchema>> {
    const output = await this.commandRunner({
      arguments: [
        "exec",
        "-T",
        "docling-benchmark",
        "python",
        "-c",
        EFFECTIVE_SERVICE_CONFIGURATION_PROBE,
      ],
      environment,
      executable: COMPOSE_WRAPPER,
    });
    let value: unknown;
    try {
      value = JSON.parse(output.trim());
    } catch (error: unknown) {
      throw new Error("The Docling service probe returned invalid JSON.", {
        cause: error,
      });
    }
    const result = effectiveServiceConfigurationSchema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `The Docling service probe returned invalid settings: ${result.error.message}`,
      );
    }
    return result.data;
  }
}

export class DoclingServiceMeasurement {
  private interval: ReturnType<typeof setInterval> | null = null;
  private peakResidentBytes: number | null;
  private sampling: Promise<void> = Promise.resolve();

  private constructor(
    private readonly baseUrl: string,
    private readonly before: DoclingPrometheusSnapshot | null,
  ) {
    this.peakResidentBytes = before?.residentBytes ?? null;
  }

  public static async start(baseUrl: string): Promise<DoclingServiceMeasurement> {
    const before = await readOptionalMetrics(baseUrl);
    const measurement = new DoclingServiceMeasurement(baseUrl, before);
    measurement.interval = setInterval(() => {
      measurement.sampling = measurement.sampling.then(async () => {
        const snapshot = await readOptionalMetrics(baseUrl);
        measurement.observe(snapshot);
      });
    }, METRICS_SAMPLE_INTERVAL_MS);
    measurement.interval.unref();
    return measurement;
  }

  public async finish(): Promise<DoclingBenchmarkServiceMeasurement> {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.sampling;
    const after = await readOptionalMetrics(this.baseUrl);
    this.observe(after);
    if (this.before === null || after === null) {
      return {
        cpuTimeMs: null,
        httpRequestCount: null,
        httpRequestDurationMs: null,
        peakResidentBytes: this.peakResidentBytes,
        statusPollRequestCount: null,
      };
    }
    const delta = calculateDoclingPrometheusDelta(this.before, after);
    return buildMeasurement(delta, this.peakResidentBytes);
  }

  private observe(snapshot: DoclingPrometheusSnapshot | null): void {
    if (snapshot === null) {
      return;
    }
    this.peakResidentBytes = Math.max(
      this.peakResidentBytes ?? 0,
      snapshot.residentBytes,
    );
  }
}

export function createBenchmarkDoclingConfig(baseUrl: string): DoclingConfig {
  return {
    apiKey: null,
    baseTimeoutMs: 1_800_000,
    baseUrl,
    maxTimeoutMs: 43_200_000,
    megabyteTimeoutMs: 60_000,
    ocrEnabled: true,
    pageTimeoutMs: 30_000,
    pdfBackend: "docling_parse",
    performanceMetricsEnabled: false,
    performanceMetricsRetentionDays: 30,
    requestTimeoutMs: 300_000,
    secondaryImageScale: 2,
    tableMode: "accurate",
    tableStructureEnabled: true,
  };
}

async function runCommand(command: BenchmarkServiceCommand): Promise<string> {
  const value = await executeFile(command.executable, command.arguments, {
    cwd: process.cwd(),
    env: command.environment,
    maxBuffer: 10 * 1_024 * 1_024,
  });
  const result = commandOutputSchema.safeParse(value);
  if (!result.success) {
    throw new Error("The benchmark service command returned invalid output.");
  }
  return result.data.stdout;
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Docling capability request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function readOptionalMetrics(
  baseUrl: string,
): Promise<DoclingPrometheusSnapshot | null> {
  try {
    const response = await fetch(`${baseUrl}/metrics`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return null;
    }
    return decodeDoclingPrometheusMetrics(await response.text());
  } catch {
    return null;
  }
}

function buildMeasurement(
  delta: DoclingPrometheusDelta,
  peakResidentBytes: number | null,
): DoclingBenchmarkServiceMeasurement {
  return {
    cpuTimeMs: delta.cpuTimeMs,
    httpRequestCount: delta.httpRequestCount,
    httpRequestDurationMs: delta.httpRequestDurationMs,
    peakResidentBytes,
    statusPollRequestCount: delta.statusPollRequestCount,
  };
}

function sameProcessConfiguration(
  left: DoclingBenchmarkProcessConfiguration,
  right: DoclingBenchmarkProcessConfiguration,
): boolean {
  return isDeepStrictEqual(left, right);
}
