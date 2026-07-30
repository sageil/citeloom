import {
  readArray,
  readBoolean,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readNullableNonNegativeInteger,
  readPlainObject,
  readPositiveInteger,
} from "./citeloom-boundaries.js";
import {
activateSystemHealthDashboard,
deactivateSystemHealthDashboard,
} from "./citeloom-dashboard-extensions.js";

const telemetryRequestKinds = Object.freeze([
  "answer",
  "benchmark",
  "chat",
  "retrieval",
  "search",
]);
const telemetryStageNames = Object.freeze([
  "answer",
  "claim-verification",
  "dense-retrieval",
  "fusion",
  "hydration",
  "lexical-retrieval",
  "query-embedding",
  "query-expansion",
  "reranking",
  "scope-resolution",
]);
const telemetryWorkloads = Object.freeze([
  "offline-tool",
  "ingestion",
  "interactive-answer",
  "interactive-search",
  "maintenance",
]);
const workerStates = Object.freeze(["idle", "starting", "stopped", "working"]);

function readSystemHealthDashboard(dashboard, system, queue) {
  const workers = readWorkerStatuses(system.workers);
  const inference = readInferenceStatuses(system.inference);
  const embeddingSpace = readPlainObject(
    dashboard.embeddingSpace,
    "embedding space",
  );
  const inferenceRuntime = readPlainObject(
    dashboard.inferenceRuntime,
    "inference runtime",
  );
  const claimVerifier = readPlainObject(
    inferenceRuntime.claimVerifier,
    "claim verifier",
  );

  let workerState = "available";
  for (const worker of workers) {
    if (worker.state === "working") {
      workerState = "processing";
      break;
    }
  }

  return {
    inference,
    models: {
      answer: readNonEmptyString(inferenceRuntime.answerModel, "answer model"),
      claimVerifier: readNonEmptyString(claimVerifier.model, "claim verifier model"),
      embedding: readNonEmptyString(embeddingSpace.model, "embedding model"),
      queryExpansion: readNonEmptyString(
        inferenceRuntime.queryExpansionModel,
        "query-expansion model",
      ),
      reranker: readReranker(inferenceRuntime.reranker),
      summary: readNonEmptyString(inferenceRuntime.summaryModel, "summary model"),
    },
    queueLength: queue.length,
    telemetry: readTelemetry(dashboard.telemetry),
    workerCount: workers.length,
    workerState,
  };
}

function readWorkerStatuses(value) {
  const values = readArray(value, "dashboard workers");
  const workers = [];
  for (const value of values) {
    const worker = readPlainObject(value, "dashboard worker");
    workers.push({
      state: readEnum(worker.state, workerStates, "dashboard worker state"),
    });
  }
  return workers;
}

function readInferenceStatuses(value) {
  const values = readArray(value, "inference capacity");
  const inference = [];
  for (const value of values) {
    const resource = readPlainObject(value, "inference capacity resource");
    inference.push({
      activeSlots: readNonNegativeInteger(
        resource.activeSlots,
        "inference active slots",
      ),
      capacity: readPositiveInteger(resource.capacity, "inference capacity"),
      name: readNonEmptyString(
        resource.name,
        "inference provider name",
      ),
      providerId: readNonEmptyString(
        resource.providerId,
        "inference provider",
      ),
    });
  }
  return inference;
}

function readReranker(value) {
  if (value === null) {
    return "Disabled";
  }
  const reranker = readPlainObject(value, "reranker");
  return readNonEmptyString(reranker.model, "reranker model");
}

function readTelemetry(value) {
  const telemetry = readPlainObject(value, "telemetry");
  readNonEmptyString(telemetry.generatedAt, "telemetry generated time");
  readPositiveInteger(telemetry.windowHours, "telemetry window");
  return {
    enabled: readBoolean(telemetry.enabled, "telemetry enabled state"),
    requests: readTelemetryRequests(telemetry.requests),
    scheduling: readTelemetryScheduling(telemetry.scheduling),
    stages: readTelemetryStages(telemetry.stages),
  };
}

function readTelemetryRequests(value) {
  const values = readArray(value, "request telemetry");
  const rows = [];
  for (const value of values) {
    const request = readPlainObject(value, "request telemetry row");
    const latency = readTelemetryPercentiles(
      request.requestLatencyMs,
      "request latency",
    );
    readTelemetryPercentiles(request.streamDurationMs, "stream duration");
    readTelemetryPercentiles(request.timeToFirstTokenMs, "time to first token");
    rows.push({
      abortRate: readTelemetryRate(request.abortRate, "request abort rate"),
      errorRate: readTelemetryRate(request.errorRate, "request error rate"),
      fallbackRate: readTelemetryRate(request.fallbackRate, "request fallback rate"),
      label: readEnum(request.kind, telemetryRequestKinds, "request kind"),
      model: "All models",
      p50: latency.p50,
      p95: latency.p95,
      p99: latency.p99,
      providerP95: null,
      queueP95: null,
      samples: readNonNegativeInteger(
        request.sampleCount,
        "request sample count",
      ),
    });
  }
  return rows;
}

function readTelemetryStages(value) {
  const values = readArray(value, "stage telemetry");
  const rows = [];
  for (const value of values) {
    const stage = readPlainObject(value, "stage telemetry row");
    const duration = readTelemetryPercentiles(stage.durationMs, "stage duration");
    const providerDuration = readTelemetryPercentiles(
      stage.providerDurationMs,
      "provider duration",
    );
    const schedulerWait = readTelemetryPercentiles(
      stage.schedulerWaitMs,
      "scheduler wait",
    );
    const modelId = readNullableNonEmptyString(stage.modelId, "stage model");
    const provider = readNullableNonEmptyString(stage.provider, "stage provider");
    let model = "Database or local";
    if (modelId !== null) {
      model = `${provider ?? "Unknown provider"}/${modelId}`;
    }
    rows.push({
      abortRate: readTelemetryRate(stage.abortRate, "stage abort rate"),
      errorRate: readTelemetryRate(stage.errorRate, "stage error rate"),
      fallbackRate: readTelemetryRate(stage.fallbackRate, "stage fallback rate"),
      label: readEnum(stage.name, telemetryStageNames, "telemetry stage"),
      model,
      p50: duration.p50,
      p95: duration.p95,
      p99: duration.p99,
      providerP95: providerDuration.p95,
      queueP95: schedulerWait.p95,
      samples: readNonNegativeInteger(stage.sampleCount, "stage sample count"),
    });
  }
  return rows;
}

function readTelemetryScheduling(value) {
  const values = readArray(value, "scheduling telemetry");
  const rows = [];
  for (const value of values) {
    const sample = readPlainObject(value, "scheduling telemetry row");
    const execution = readTelemetryPercentiles(
      sample.executionDurationMs,
      "scheduling execution duration",
    );
    const queueWait = readTelemetryPercentiles(
      sample.queueWaitMs,
      "scheduling queue wait",
    );
    rows.push({
      abortRate: readTelemetryRate(sample.abortRate, "scheduling abort rate"),
      errorRate: readTelemetryRate(sample.errorRate, "scheduling error rate"),
      fallbackRate: 0,
      label: readEnum(sample.workload, telemetryWorkloads, "scheduling workload"),
      model: readNonEmptyString(
        sample.resourceGroup,
        "scheduling provider",
      ),
      p50: execution.p50,
      p95: execution.p95,
      p99: execution.p99,
      providerP95: null,
      queueP95: queueWait.p95,
      samples: readNonNegativeInteger(
        sample.sampleCount,
        "scheduling sample count",
      ),
    });
  }
  return rows;
}

function readTelemetryPercentiles(value, label) {
  const percentiles = readPlainObject(value, label);
  return {
    p50: readNullableNonNegativeInteger(percentiles.p50, `${label} p50`),
    p95: readNullableNonNegativeInteger(percentiles.p95, `${label} p95`),
    p99: readNullableNonNegativeInteger(percentiles.p99, `${label} p99`),
  };
}

function readTelemetryRate(value, label) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function buildEmptySystemHealth() {
  return {
    inference: [],
    models: {
      answer: "Unavailable",
      claimVerifier: "Unavailable",
      embedding: "Unavailable",
      queryExpansion: "Unavailable",
      reranker: "Disabled",
      summary: "Unavailable",
    },
    queueLength: 0,
    telemetry: {
      enabled: false,
      requests: [],
      scheduling: [],
      stages: [],
    },
    workerCount: 0,
    workerState: "available",
  };
}

export function registerPage(alpine) {
  alpine.data("citeloomSystemHealthPage", () => ({
    snapshotListener: null,
    systemHealth: buildEmptySystemHealth(),
    systemHealthHasData: false,

    get telemetryTables() {
      const tables = [];
      if (this.systemHealth.telemetry.requests.length > 0) {
        tables.push({
          caption: "End-to-end requests",
          id: "requests",
          rows: this.systemHealth.telemetry.requests,
          scrollable: false,
        });
      }
      if (this.systemHealth.telemetry.stages.length > 0) {
        tables.push({
          caption: "Stages by model",
          id: "stages",
          rows: this.systemHealth.telemetry.stages,
          scrollable: this.systemHealth.telemetry.stages.length > 3,
        });
      }
      return tables;
    },

    initialize() {
      this.snapshotListener = (event) => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        this.systemHealth = event.detail;
        this.systemHealthHasData = true;
      };
      window.addEventListener(
        "citeloom:system-health-snapshot",
        this.snapshotListener,
      );
      activateSystemHealthDashboard(readSystemHealthDashboard);
      window.dispatchEvent(new CustomEvent("citeloom:dashboard-refresh-request"));
    },

    destroy() {
      deactivateSystemHealthDashboard(readSystemHealthDashboard);
      if (this.snapshotListener !== null) {
        window.removeEventListener(
          "citeloom:system-health-snapshot",
          this.snapshotListener,
        );
      }
    },

    formatRelativeTime(value) {
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) {
        return "recently";
      }
      const elapsedSeconds = Math.max(
        0,
        Math.round((Date.now() - timestamp) / 1_000),
      );
      if (elapsedSeconds < 10) {
        return "now";
      }
      if (elapsedSeconds < 60) {
        return `${elapsedSeconds} sec ago`;
      }
      const minutes = Math.floor(elapsedSeconds / 60);
      if (minutes < 60) {
        return `${minutes} min ago`;
      }
      return `${Math.floor(minutes / 60)} hr ago`;
    },

    formatProviderLabel(providerId) {
      const current = this.systemHealth?.inference.find((resource) => {
        return resource.providerId === providerId;
      });
      if (current !== undefined) {
        return current.name;
      }
      const label = providerId.split("-").join(" ");
      return label.charAt(0).toUpperCase() + label.slice(1);
    },

    formatSnapshotResourceLabel(resourceGroup) {
      if (resourceGroup === "document-conversion") {
        return "Conversion";
      }
      return this.formatProviderLabel(resourceGroup);
    },

    formatTelemetryDuration(value) {
      if (value === null) {
        return "-";
      }
      if (value < 1_000) {
        return `${value} ms`;
      }
      const precision = value < 60_000 ? 1 : 0;
      return `${(value / 1_000).toFixed(precision)} s`;
    },

    formatTelemetryRate(value) {
      return `${(value * 100).toFixed(1)}%`;
    },

    providerIconHref(providerId) {
      const icon = providerId === "ollama"
        || providerId === "lmstudio"
        || providerId === "omlx"
        ? "brain"
        : "database";
      return `./assets/images/citeloom-icons.svg#citeloom-${icon}`;
    },
  }));
}
