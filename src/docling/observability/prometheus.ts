const HTTP_DURATION_COUNT = "http_server_duration_milliseconds_count";
const HTTP_DURATION_SUM = "http_server_duration_milliseconds_sum";
const PROCESS_CPU_SECONDS = "process_cpu_seconds_total";
const PROCESS_RESIDENT_BYTES = "process_resident_memory_bytes";

export interface DoclingPrometheusSnapshot {
  cpuSeconds: number;
  httpRequestCount: number;
  httpRequestDurationMs: number;
  residentBytes: number;
  statusPollRequestCount: number;
}

export interface DoclingPrometheusDelta {
  cpuTimeMs: number;
  httpRequestCount: number;
  httpRequestDurationMs: number;
  statusPollRequestCount: number;
}

interface PrometheusSample {
  labels: Map<string, string>;
  name: string;
  value: number;
}

export function decodeDoclingPrometheusMetrics(
  text: string,
): DoclingPrometheusSnapshot {
  if (text.length > 10 * 1_024 * 1_024) {
    throw new Error("Docling metrics response exceeds the 10 MiB safety limit.");
  }
  let cpuSeconds: number | null = null;
  let httpRequestCount = 0;
  let httpRequestDurationMs = 0;
  let residentBytes: number | null = null;
  let statusPollRequestCount = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sample = decodePrometheusSample(line);
    if (sample.name === PROCESS_CPU_SECONDS) {
      cpuSeconds = sample.value;
      continue;
    }
    if (sample.name === PROCESS_RESIDENT_BYTES) {
      residentBytes = sample.value;
      continue;
    }
    if (sample.name !== HTTP_DURATION_COUNT && sample.name !== HTTP_DURATION_SUM) {
      continue;
    }
    const target = sample.labels.get("http_target");
    if (target === undefined || isInstrumentationTarget(target)) {
      continue;
    }
    if (sample.name === HTTP_DURATION_COUNT) {
      httpRequestCount += sample.value;
      if (target.startsWith("/v1/status/poll/")) {
        statusPollRequestCount += sample.value;
      }
      continue;
    }
    httpRequestDurationMs += sample.value;
  }
  if (cpuSeconds === null || residentBytes === null) {
    throw new Error("Docling metrics omit process CPU or resident memory.");
  }
  return {
    cpuSeconds,
    httpRequestCount: Math.round(httpRequestCount),
    httpRequestDurationMs,
    residentBytes: Math.round(residentBytes),
    statusPollRequestCount: Math.round(statusPollRequestCount),
  };
}

export function calculateDoclingPrometheusDelta(
  before: DoclingPrometheusSnapshot,
  after: DoclingPrometheusSnapshot,
): DoclingPrometheusDelta {
  return {
    cpuTimeMs: Math.max(0, Math.round((after.cpuSeconds - before.cpuSeconds) * 1_000)),
    httpRequestCount: Math.max(
      0,
      after.httpRequestCount - before.httpRequestCount,
    ),
    httpRequestDurationMs: Math.max(
      0,
      after.httpRequestDurationMs - before.httpRequestDurationMs,
    ),
    statusPollRequestCount: Math.max(
      0,
      after.statusPollRequestCount - before.statusPollRequestCount,
    ),
  };
}

function decodePrometheusSample(line: string): PrometheusSample {
  const match = /^(?<name>[A-Za-z_:][A-Za-z0-9_:]*)(?:\{(?<labels>.*)\})?\s+(?<value>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/.exec(line);
  if (match?.groups === undefined) {
    throw new Error("Docling metrics contain an invalid Prometheus sample.");
  }
  const value = Number(match.groups.value);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Docling metrics contain an invalid numeric value.");
  }
  return {
    labels: decodePrometheusLabels(match.groups.labels ?? ""),
    name: match.groups.name ?? "",
    value,
  };
}

function decodePrometheusLabels(value: string): Map<string, string> {
  const labels = new Map<string, string>();
  let remaining = value.trim();
  while (remaining.length > 0) {
    const match = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)="(?<value>(?:[^"\\]|\\.)*)"(?:,|$)/.exec(remaining);
    if (match?.groups === undefined) {
      throw new Error("Docling metrics contain invalid Prometheus labels.");
    }
    labels.set(match.groups.name ?? "", decodePrometheusLabelValue(match.groups.value ?? ""));
    remaining = remaining.slice(match[0].length).trim();
  }
  return labels;
}

function decodePrometheusLabelValue(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\");
}

function isInstrumentationTarget(target: string): boolean {
  return target === "/health"
    || target === "/metrics"
    || target === "/openapi.json"
    || target === "/ready"
    || target === "/version";
}
