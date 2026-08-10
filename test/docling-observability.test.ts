import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoclingConfig } from "../src/config/index.js";
import {
  parseDoclingBenchmarkArguments,
  readDoclingBenchmarkProcessConfiguration,
} from "../scripts/docling-benchmark/cli.js";
import { decodeDoclingCapabilities } from "../src/docling/client/capabilities.js";
import {
  decodeDoclingBenchmarkCandidate,
  decodeDoclingBenchmarkEnvironment,
  type DoclingBenchmarkProcessConfiguration,
} from "../scripts/docling-benchmark/model.js";
import {
  buildDoclingContentRequest,
  buildDoclingConversionOptions,
  readDoclingEffectiveRequestOptions,
} from "../src/docling/client/conversion-request.js";
import {
  readDoclingPromotionScreenOutcome,
  selectDoclingBenchmarkWarmupDocument,
} from "../scripts/docling-benchmark/runner.js";
import type { StoredDoclingBenchmarkResult } from "../scripts/docling-benchmark/store.js";
import {
  DoclingBenchmarkService,
  type BenchmarkServiceCommand,
  type DoclingBenchmarkServiceDependencies,
} from "../scripts/docling-benchmark/service.js";
import { evaluateDoclingPromotion } from "../scripts/docling-benchmark/promotion-gate.js";
import {
  calculateDoclingPrometheusDelta,
  decodeDoclingPrometheusMetrics,
} from "../src/docling/observability/prometheus.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Docling request configuration", () => {
  it("builds one embedded-image content request", () => {
    const config = buildConfig();
    config.pdfBackend = "threaded_docling_parse";
    config.ocrEnabled = false;
    config.tableMode = "fast";
    const source = buildSource();
    const options = buildDoclingConversionOptions(config, source);
    const request = buildDoclingContentRequest(
      source,
      options,
      120_000,
      "00000000-0000-4000-8000-000000000001",
    );

    expect(request).toMatchObject({
      byte_length: 3,
      document_id: "a".repeat(64),
      filename: "benchmark.pdf",
      options: {
        abort_on_error: true,
        do_ocr: false,
        do_table_structure: true,
        document_timeout: 120,
        force_ocr: false,
        from_formats: ["pdf"],
        image_export_mode: "embedded",
        images_scale: 2,
        include_images: true,
        include_page_images: false,
        ocr_preset: "rapidocr",
        pdf_backend: "threaded_docling_parse",
        pipeline: "standard",
        table_cell_matching: true,
        table_mode: "fast",
        to_formats: ["json"],
      },
      task_id: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("builds the production PDF request options", () => {
    const config = buildConfig();
    const source = buildSource();
    const options = buildDoclingConversionOptions(config, source);
    const request = buildDoclingContentRequest(
      source,
      options,
      43_195_000,
      "00000000-0000-4000-8000-000000000002",
    );

    expect(request.options).toEqual({
      abort_on_error: true,
      do_ocr: true,
      do_table_structure: true,
      document_timeout: 43_195,
      force_ocr: false,
      from_formats: ["pdf"],
      image_export_mode: "embedded",
      images_scale: 2,
      include_images: true,
      include_page_images: false,
      ocr_preset: "rapidocr",
      pdf_backend: "docling_parse",
      pipeline: "standard",
      table_cell_matching: true,
      table_mode: "accurate",
      to_formats: ["json"],
    });
  });

  it("records the PDF backend as ineffective for non-PDF inputs", () => {
    const config = buildConfig();
    config.pdfBackend = "threaded_docling_parse";
    const docxSource = buildDocxSource();
    const htmlSource = buildHtmlSource();
    const docxOptions = buildDoclingConversionOptions(config, docxSource);
    const htmlOptions = buildDoclingConversionOptions(config, htmlSource);

    expect(
      readDoclingEffectiveRequestOptions(docxSource, docxOptions).pdfBackend,
    ).toBeNull();
    expect(
      readDoclingEffectiveRequestOptions(htmlSource, htmlOptions).pdfBackend,
    ).toBeNull();
  });

  it("records table mode as ineffective when extraction is disabled", () => {
    const config = buildConfig();
    config.tableStructureEnabled = false;
    const source = buildSource();
    const options = buildDoclingConversionOptions(config, source);

    expect(readDoclingEffectiveRequestOptions(
      source,
      options,
    )).toMatchObject({
      doTableStructure: false,
      includeImages: true,
      includePageImages: false,
      tableMode: null,
    });
  });
});

describe("Docling benchmark corpus", () => {
  it("uses the smallest PDF for backend warmup", () => {
    const warmup = selectDoclingBenchmarkWarmupDocument([
      {
        byteLength: 10,
        documentId: "a".repeat(64),
        extension: ".docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        byteLength: 30,
        documentId: "b".repeat(64),
        extension: ".pdf",
        mediaType: "application/pdf",
      },
      {
        byteLength: 20,
        documentId: "c".repeat(64),
        extension: ".pdf",
        mediaType: "application/pdf",
      },
    ]);

    expect(warmup?.documentId).toBe("c".repeat(64));
  });

  it("rejects malformed nested benchmark configuration", () => {
    expect(() => decodeDoclingBenchmarkCandidate({
      id: "final:baseline",
      phase: "finalist",
      process: {
        numThreads: 4,
        pageBatchSize: "4",
        profilePipelineTimings: true,
      },
      request: buildDoclingConversionOptions(buildConfig(), buildSource()),
      secondaryImageScale: 2,
    })).toThrow("Invalid Docling benchmark candidate");
  });

  it("keeps the benchmark timeout invariant at the boundary", () => {
    expect(() => decodeDoclingBenchmarkEnvironment({
      baseUrl: "http://127.0.0.1:5002",
      baseline: {
        baseTimeoutMs: 120_000,
        maxTimeoutMs: 60_000,
        megabyteTimeoutMs: 60_000,
        pageTimeoutMs: 30_000,
        requestTimeoutMs: 60_000,
        settingsVersion: 1,
      },
      capabilitiesFingerprint: "a".repeat(64),
      composeProject: "citeloom",
      corpusFingerprint: "b".repeat(64),
      cpuCount: 8,
      imageReference: "docling:test",
      ocrPreset: "rapidocr",
      process: buildBenchmarkProcessConfiguration(),
      service: {
        coreVersion: "2.87.1",
        jobkitVersion: "2.1.0",
        modelsVersion: "3.13.3",
        parseVersion: "7.8.1",
        serveVersion: "1.27.0",
        version: "2.113.0",
      },
    })).toThrow("baseline timeout exceeds its hard deadline");
  });
});

describe("Docling capability boundary", () => {
  it("accepts the pinned async conversion surface", () => {
    expect(decodeDoclingCapabilities(buildOpenApi()).fingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects a service that only appears to support the backend setting", () => {
    const openApi = buildOpenApi();
    const properties = openApi.components.schemas.ConvertOptions.properties as {
      [key: string]: unknown;
    };
    delete properties.pdf_backend;

    expect(() => decodeDoclingCapabilities(openApi)).toThrow(
      "missing pdf_backend",
    );
  });

  it("rejects a service without the fixed OCR preset field", () => {
    const openApi = buildOpenApi();
    const properties = openApi.components.schemas.ConvertOptions.properties as {
      [key: string]: unknown;
    };
    delete properties.ocr_preset;

    expect(() => decodeDoclingCapabilities(openApi)).toThrow(
      "missing ocr_preset",
    );
  });

  it("requires supported backends in the pdf_backend enum itself", () => {
    const openApi = buildOpenApi();
    openApi.components.schemas.ConvertOptions.properties.pdf_backend.enum = [
      "docling_parse",
      "pypdfium2",
    ];

    expect(() => decodeDoclingCapabilities(openApi)).toThrow(
      "does not advertise threaded_docling_parse",
    );
  });

});

describe("isolated Docling benchmark service", () => {
  it("verifies the live process settings and service capabilities after startup", async () => {
    const commands: BenchmarkServiceCommand[] = [];
    const commandRunner = async (command: BenchmarkServiceCommand): Promise<string> => {
      commands.push(command);
      if (command.arguments.includes("exec")) {
        return JSON.stringify(buildEffectiveServiceConfiguration({
          numThreads: 8,
        }));
      }
      return "";
    };
    const service = new DoclingBenchmarkService(
      commandRunner,
      "http://benchmark.test",
      buildBenchmarkDependencies(),
    );

    const process = buildBenchmarkProcessConfiguration({ numThreads: 8 });
    const environment = await service.start(process);
    await service.stop();

    expect(environment).toMatchObject({
      baseUrl: "http://benchmark.test",
      imageReference:
        "citeloom/docling-serve-cpu:1.27.0-ppocrv5-2d2fd797",
      ocrPreset: "rapidocr",
      process,
      service: { serveVersion: "1.27.0", version: "2.113.0" },
    });
    expect(commands.every((command) => {
      return command.arguments.includes("docling-benchmark");
    })).toBe(true);
    expect(commands.every((command) => {
      return command.executable === "./scripts/docling-benchmark/compose.sh";
    })).toBe(true);
    expect(commands.some((command) => {
      return command.arguments.includes("--profile");
    })).toBe(false);
    expect(commands).toHaveLength(4);
  });

  it("fails startup when a requested process setting is ineffective", async () => {
    const commandRunner = async (command: BenchmarkServiceCommand): Promise<string> => {
      if (command.arguments.includes("exec")) {
        return JSON.stringify(buildEffectiveServiceConfiguration({
          layoutBatchSize: 99,
        }));
      }
      return "";
    };
    const service = new DoclingBenchmarkService(
      commandRunner,
      "http://benchmark.test",
      buildBenchmarkDependencies(),
    );

    await expect(service.start(
      buildBenchmarkProcessConfiguration(),
    )).rejects.toThrow("did not apply");
  });

  it("fails startup when the fixed OCR preset is ineffective", async () => {
    const commandRunner = async (command: BenchmarkServiceCommand): Promise<string> => {
      if (command.arguments.includes("exec")) {
        const effective = buildEffectiveServiceConfiguration();
        effective.ocr.defaultPreset = "auto";
        return JSON.stringify(effective);
      }
      return "";
    };
    const service = new DoclingBenchmarkService(
      commandRunner,
      "http://benchmark.test",
      buildBenchmarkDependencies(),
    );

    await expect(service.start(
      buildBenchmarkProcessConfiguration(),
    )).rejects.toThrow("service probe returned invalid settings");
  });
});

describe("Docling Prometheus boundary", () => {
  it("summarizes process and conversion HTTP counters without instrumentation", () => {
    const before = decodeDoclingPrometheusMetrics(buildMetrics(10, 1_000, 2, 30, 0));
    const after = decodeDoclingPrometheusMetrics(buildMetrics(12.5, 1_500, 5, 90, 1));

    expect(calculateDoclingPrometheusDelta(before, after)).toEqual({
      cpuTimeMs: 2_500,
      httpRequestCount: 3,
      httpRequestDurationMs: 60,
      statusPollRequestCount: 1,
    });
    expect(after.residentBytes).toBe(1_500);
  });

  it("rejects malformed samples at the transport boundary", () => {
    expect(() => decodeDoclingPrometheusMetrics("not prometheus\n")).toThrow(
      "invalid Prometheus sample",
    );
  });
});

describe("threaded Docling promotion gate", () => {
  it("passes complete, equivalent, faster results within capacity limits", () => {
    const results = buildPromotionResults(false);
    const assessment = evaluateDoclingPromotion({
      baselineCandidateId: "final:baseline",
      candidateId: "final:threaded",
      expectedDocumentCount: 2,
      p95LatencyRegressionLimit: 0.1,
      peakMemoryRegressionLimit: 0.1,
      performanceThreshold: 0.1,
      repetitions: 3,
      results,
    });

    expect(assessment.eligible).toBe(true);
    expect(assessment.performanceImprovement).toBeCloseTo(0.2);
    expect(assessment.reasons).toEqual([]);
  });

  it("fails closed on any output-quality difference", () => {
    const assessment = evaluateDoclingPromotion({
      baselineCandidateId: "final:baseline",
      candidateId: "final:threaded",
      expectedDocumentCount: 2,
      p95LatencyRegressionLimit: 0.1,
      peakMemoryRegressionLimit: 0.1,
      performanceThreshold: 0.1,
      repetitions: 3,
      results: buildPromotionResults(true),
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons).toContain(
      "1 candidate result(s) failed output equivalence.",
    );
  });

  it("requires the performance threshold in every full-corpus repetition", () => {
    const results = buildPromotionResults(false);
    for (const result of results) {
      if (result.candidateId === "final:threaded" && result.repetition === 3) {
        result.totalWallMs = 95;
      }
    }
    const assessment = evaluateDoclingPromotion({
      baselineCandidateId: "final:baseline",
      candidateId: "final:threaded",
      expectedDocumentCount: 2,
      p95LatencyRegressionLimit: 0.1,
      peakMemoryRegressionLimit: 0.1,
      performanceThreshold: 0.1,
      repetitions: 3,
      results,
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons).toContain(
      "Every full-corpus repetition must meet the preregistered 10.0% improvement threshold.",
    );
  });

  it("requires the baseline finalist to reproduce the fresh baseline", () => {
    const results = buildPromotionResults(false);
    const baseline = results.find((result) => {
      return result.candidateId === "final:baseline";
    });
    if (baseline === undefined) {
      throw new Error("Missing baseline result fixture.");
    }
    baseline.comparison = {
      differences: [{
        actual: "b".repeat(64),
        expected: "a".repeat(64),
        path: "output.elements[0].content",
      }],
      passed: false,
    };
    baseline.qualityPassed = false;
    const assessment = evaluateDoclingPromotion({
      baselineCandidateId: "final:baseline",
      candidateId: "final:threaded",
      expectedDocumentCount: 2,
      p95LatencyRegressionLimit: 0.1,
      peakMemoryRegressionLimit: 0.1,
      performanceThreshold: 0.1,
      repetitions: 3,
      results,
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons).toContain(
      "1 baseline result(s) failed output equivalence.",
    );
  });
});

describe("Docling benchmark progression", () => {
  it("fails the promotion screen closed on durable candidate evidence", () => {
    expect(readDoclingPromotionScreenOutcome([], 2)).toEqual({
      status: "pending",
    });
    const failed = buildStoredBenchmarkResult(
      "screen:threaded_docling_parse",
      "error",
      false,
    );
    const outcome = readDoclingPromotionScreenOutcome([failed], 2);
    expect(outcome.status).toBe("eliminated");
    if (outcome.status === "eliminated") {
      expect(outcome.reason).toContain("1 conversion error(s)");
    }

    const qualified = [
      buildStoredBenchmarkResult(
        "screen:threaded_docling_parse",
        "success",
        true,
      ),
      {
        ...buildStoredBenchmarkResult(
          "screen:threaded_docling_parse",
          "success",
          true,
        ),
        documentId: "b".repeat(64),
      },
    ];
    expect(readDoclingPromotionScreenOutcome(qualified, 2)).toEqual({
      status: "qualified",
    });
  });

  it("parses explicit quality-tradeoff and resume options", () => {
    const runId = "00000000-0000-4000-8000-000000000901";
    expect(parseDoclingBenchmarkArguments([])).toEqual({
      includeQualityTradeoffs: false,
      processOnly: false,
    });
    expect(parseDoclingBenchmarkArguments([
      "--resume",
      runId,
      "--include-quality-tradeoffs",
    ])).toEqual({
      includeQualityTradeoffs: true,
      processOnly: false,
      runId,
    });
    expect(() => parseDoclingBenchmarkArguments([
      "--include-quality-tradeoffs",
      "--include-quality-tradeoffs",
    ])).toThrow("more than once");
  });

  it("uses the production memory controls as benchmark defaults", () => {
    const process = readDoclingBenchmarkProcessConfiguration({});

    expect(process.localWorkerCount).toBe(1);
    expect(process.queueMaxSize).toBe(8);
    expect(process.layoutBatchSize).toBe(4);
    expect(process.ocrBatchSize).toBe(4);
    expect(process.tableBatchSize).toBe(4);
  });
});

function buildConfig(): DoclingConfig {
  return {
    apiKey: null,
    baseTimeoutMs: 120_000,
    baseUrl: "http://docling.test",
    maxTimeoutMs: 600_000,
    megabyteTimeoutMs: 60_000,
    ocrEnabled: true,
    pageTimeoutMs: 30_000,
    pdfBackend: "docling_parse",
    performanceMetricsEnabled: false,
    performanceMetricsRetentionDays: 30,
    pipeline: "standard",
    requestTimeoutMs: 300_000,
    secondaryImageScale: 2,
    tableMode: "accurate",
    tableStructureEnabled: true,
    tocEnabled: true,
    vlm: null,
  };
}

function buildStoredBenchmarkResult(
  candidateId: string,
  outcome: StoredDoclingBenchmarkResult["outcome"],
  qualityPassed: boolean,
): StoredDoclingBenchmarkResult {
  return {
    candidateId,
    comparison: qualityPassed ? { differences: [], passed: true } : null,
    documentId: "a".repeat(64),
    outcome,
    peakResidentBytes: outcome === "success" ? 1_000 : null,
    qualityPassed,
    repetition: 1,
    totalWallMs: outcome === "success" ? 1_000 : null,
  };
}

function buildSource() {
  return {
    byteLength: 3,
    documentId: "a".repeat(64),
    extension: ".pdf" as const,
    kind: "file" as const,
    mediaType: "application/pdf" as const,
    openContent: async () => {
      throw new Error("Configuration tests do not open source content.");
    },
    sourceFile: "benchmark.pdf",
  };
}

function buildDocxSource() {
  return {
    byteLength: 4,
    documentId: "b".repeat(64),
    extension: ".docx" as const,
    kind: "file" as const,
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const,
    openContent: async () => {
      throw new Error("Configuration tests do not open source content.");
    },
    sourceFile: "benchmark.docx",
  };
}

function buildHtmlSource() {
  return {
    byteLength: 4,
    documentId: "c".repeat(64),
    extension: ".html" as const,
    kind: "file" as const,
    mediaType: "text/html" as const,
    openContent: async () => {
      throw new Error("Configuration tests do not open source content.");
    },
    sourceFile: "benchmark.html",
  };
}

function buildOpenApi() {
  return {
    components: {
      schemas: {
        ContentRequest: {
          properties: {
            byte_length: {},
            document_id: {},
            filename: {},
            options: { $ref: "#/components/schemas/ConvertOptions" },
            task_id: {},
          },
        },
        ConvertOptions: {
          properties: {
            abort_on_error: {},
            do_ocr: {},
            do_table_structure: {},
            document_timeout: {},
            force_ocr: {},
            from_formats: {},
            image_export_mode: {},
            images_scale: {},
            include_images: {},
            include_page_images: {},
            ocr_preset: {},
            pdf_backend: {
              enum: [
                "docling_parse",
                "pypdfium2",
                "threaded_docling_parse",
              ],
            },
            pipeline: { enum: ["standard", "vlm"] },
            table_cell_matching: {},
            table_mode: {},
            to_formats: {},
            vlm_pipeline_custom_config: {},
          },
        },
      },
    },
    info: { title: "Docling Serve", version: "1.27.0" },
    openapi: "3.1.0",
    paths: {
      "/v1/convert/content/async": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ContentRequest" },
              },
            },
          },
        },
      },
      "/v1/result/{task_id}": { get: {} },
      "/v1/status/poll/{task_id}": { get: {} },
      "/v1/tasks/{task_id}/pause": { post: {} },
      "/v1/tasks/{task_id}/terminate": { post: {} },
    },
  };
}

function buildBenchmarkDependencies(): DoclingBenchmarkServiceDependencies {
  return {
    readJson: async () => buildOpenApi(),
    verifyService: async () => ({
      coreVersion: "2.87.1",
      jobkitVersion: "2.1.0",
      modelsVersion: "3.13.3",
      parseVersion: "7.8.1",
      serveVersion: "1.27.0",
      version: "2.113.0",
    }),
  };
}

function buildBenchmarkProcessConfiguration(
  overrides: Partial<DoclingBenchmarkProcessConfiguration> = {},
): DoclingBenchmarkProcessConfiguration {
  return {
    batchPollingIntervalSeconds: 0.5,
    layoutBatchSize: 4,
    loadModelsAtBoot: true,
    localModelsShared: true,
    localWorkerCount: 2,
    numThreads: 4,
    ocrBatchSize: 4,
    optionsCacheSize: 2,
    profilePipelineTimings: true,
    queueMaxSize: 100,
    resultRemovalDelaySeconds: 300,
    singleUseResults: true,
    tableBatchSize: 4,
    ...overrides,
  };
}

function buildEffectiveServiceConfiguration(
  processOverrides: Partial<DoclingBenchmarkProcessConfiguration> = {},
) {
  const modelDirectory = "/opt/app-root/src/citeloom-ocr-models";
  return {
    ocr: {
      backend: "onnxruntime",
      classifierModelPath:
        `${modelDirectory}/ch_ppocr_mobile_v2.0_cls_infer.onnx`,
      defaultKind: "rapidocr",
      defaultPreset: "rapidocr",
      detectorModelPath: `${modelDirectory}/ch_PP-OCRv5_server_det.onnx`,
      kind: "rapidocr",
      maxSideLength: 1_000,
      recognitionKeysPath: `${modelDirectory}/ppocrv5_dict.txt`,
      recognitionModelPath:
        `${modelDirectory}/ch_PP-OCRv5_rec_server_infer.onnx`,
      unclipRatio: 1,
    },
    process: buildBenchmarkProcessConfiguration(processOverrides),
  };
}

function buildMetrics(
  cpuSeconds: number,
  residentBytes: number,
  requestCount: number,
  requestDurationMs: number,
  pollCount: number,
): string {
  return [
    `process_cpu_seconds_total ${cpuSeconds}`,
    `process_resident_memory_bytes ${residentBytes}`,
    `http_server_duration_milliseconds_count{http_target="/v1/result/task"} ${requestCount - pollCount}`,
    `http_server_duration_milliseconds_sum{http_target="/v1/result/task"} ${requestDurationMs}`,
    `http_server_duration_milliseconds_count{http_target="/v1/status/poll/task"} ${pollCount}`,
    "http_server_duration_milliseconds_sum{http_target=\"/v1/status/poll/task\"} 0",
    "http_server_duration_milliseconds_count{http_target=\"/metrics\"} 1000",
    "http_server_duration_milliseconds_sum{http_target=\"/metrics\"} 1000",
  ].join("\n");
}

function buildPromotionResults(
  qualityFailure: boolean,
): StoredDoclingBenchmarkResult[] {
  const results: StoredDoclingBenchmarkResult[] = [];
  for (let document = 0; document < 2; document += 1) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      results.push(buildStoredResult(
        "final:baseline",
        document,
        repetition,
        100,
        true,
      ));
      const passed = !(qualityFailure && document === 0 && repetition === 1);
      results.push(buildStoredResult(
        "final:threaded",
        document,
        repetition,
        80,
        passed,
      ));
    }
  }
  return results;
}

function buildStoredResult(
  candidateId: string,
  document: number,
  repetition: number,
  totalWallMs: number,
  qualityPassed: boolean,
): StoredDoclingBenchmarkResult {
  return {
    candidateId,
    comparison: qualityPassed ? { differences: [], passed: true } : {
      differences: [{
        actual: "b".repeat(64),
        expected: "a".repeat(64),
        path: "output.texts[0].text",
      }],
      passed: false,
    },
    documentId: String(document).repeat(64),
    outcome: "success",
    peakResidentBytes: 1_000,
    qualityPassed,
    repetition,
    totalWallMs,
  };
}
