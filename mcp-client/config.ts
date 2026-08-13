import { readFileSync } from "node:fs";

import { z } from "zod";

import { MCP_API_KEY_PREFIX } from "../src/mcp/contract.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const valueOptionNames = new Set([
  "--api-key-file",
  "--ca-file",
  "--callback-url",
  "--client-id",
  "--poll-interval-ms",
  "--question",
  "--server-url",
  "--timeout-ms",
  "--workspace",
]);

const commonCommandInputSchema = z.object({
  caFile: z.string().trim().min(1).nullable(),
  pollIntervalMs: z.number().int().min(100).max(60_000),
  question: z.string().trim().min(1).max(500),
  serverUrl: z.string().min(1),
  timeoutMs: z.number().int().min(1_000).max(60 * 60 * 1_000),
}).strict();

interface McpClientBaseConfig {
  caFile: string | null;
  pollIntervalMs: number;
  question: string;
  serverUrl: string;
  timeoutMs: number;
}

export interface McpOAuthClientConfig extends McpClientBaseConfig {
  authentication: {
    callbackUrl: string;
    clientId: string;
    kind: "oauth";
  };
  workspaceName: string;
}

export interface McpApiKeyClientConfig extends McpClientBaseConfig {
  authentication: {
    apiKey: string;
    kind: "api-key";
  };
  workspaceName: null;
}

export type McpClientConfig = McpOAuthClientConfig | McpApiKeyClientConfig;

export type McpClientCommand =
  | { kind: "help" }
  | { config: McpClientConfig; kind: "run" };

export type ReadMcpClientSecretFile = (path: string) => string;

export function readMcpClientCommand(
  argv: readonly string[],
  readSecretFile: ReadMcpClientSecretFile = readMcpClientSecretFile,
): McpClientCommand {
  const commandArguments = argv[0] === "--" ? argv.slice(1) : argv;
  const values = readOptionValues(commandArguments);
  if (values === null) {
    return { kind: "help" };
  }
  const input = commonCommandInputSchema.parse({
    caFile: values.get("--ca-file") ?? null,
    pollIntervalMs: readIntegerOption(
      values,
      "--poll-interval-ms",
      DEFAULT_POLL_INTERVAL_MS,
    ),
    question: requireOption(values, "--question"),
    serverUrl: requireOption(values, "--server-url"),
    timeoutMs: readIntegerOption(values, "--timeout-ms", DEFAULT_TIMEOUT_MS),
  });
  const commonConfig: McpClientBaseConfig = {
    caFile: input.caFile,
    pollIntervalMs: input.pollIntervalMs,
    question: input.question,
    serverUrl: readMcpServerUrl(input.serverUrl),
    timeoutMs: input.timeoutMs,
  };
  const apiKeyFile = values.get("--api-key-file");
  if (apiKeyFile !== undefined) {
    rejectOptions(values, ["--callback-url", "--client-id", "--workspace"]);
    const normalizedApiKey = readMcpApiKeyFile(apiKeyFile, readSecretFile);
    return {
      config: {
        ...commonConfig,
        authentication: { apiKey: normalizedApiKey, kind: "api-key" },
        workspaceName: null,
      },
      kind: "run",
    };
  }
  const callbackUrl = readLoopbackCallbackUrl(
    requireOption(values, "--callback-url"),
  );
  const clientId = z.string().trim().min(1).max(1_024).parse(
    requireOption(values, "--client-id"),
  );
  const workspaceName = z.string().trim().min(1).max(200).parse(
    requireOption(values, "--workspace"),
  );
  return {
    config: {
      ...commonConfig,
      authentication: { callbackUrl, clientId, kind: "oauth" },
      workspaceName,
    },
    kind: "run",
  };
}

export function mcpClientUsage(): string {
  return [
    "Usage with OAuth:",
    "  pnpm mcp:client -- \\",
    "    --server-url <https://host/mcp> \\",
    "    --client-id <native OAuth App ID> \\",
    "    --callback-url <http://127.0.0.1:port/path> \\",
    "    --workspace <CiteLoom workspace name> \\",
    "    --question <question covered by the workspace documents>",
    "",
    "Usage with an MCP API key:",
    "  pnpm mcp:client -- \\",
    "    --server-url <https://host/mcp> \\",
    "    --api-key-file <file containing a CiteLoom MCP key> \\",
    "    --question <question covered by the workspace documents>",
    "",
    "Optional:",
    "  --ca-file <PEM path>              Add a private CA for this process",
    `  --poll-interval-ms <milliseconds>  Default: ${DEFAULT_POLL_INTERVAL_MS}`,
    `  --timeout-ms <milliseconds>        Default: ${DEFAULT_TIMEOUT_MS}`,
    "  --help",
  ].join("\n");
}

function readOptionValues(argv: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return null;
    }
    if (argument === undefined || !valueOptionNames.has(argument)) {
      throw new Error(`Unknown MCP client option: ${argument ?? "(missing)"}.`);
    }
    if (values.has(argument)) {
      throw new Error(`MCP client option ${argument} was provided more than once.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`MCP client option ${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }
  return values;
}

function requireOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) {
    throw new Error(`Missing required MCP client option ${name}.`);
  }
  return value;
}

function rejectOptions(
  values: Map<string, string>,
  optionNames: readonly string[],
): void {
  for (const optionName of optionNames) {
    if (values.has(optionName)) {
      throw new Error(
        `MCP client option ${optionName} cannot be used with --api-key-file.`,
      );
    }
  }
}

function readMcpApiKeyFile(
  path: string,
  readSecretFile: ReadMcpClientSecretFile,
): string {
  let value: string;
  try {
    value = readSecretFile(path);
  } catch {
    throw new Error(`The MCP API key file could not be read: ${path}`);
  }
  return z.string()
    .trim()
    .regex(
      new RegExp(
        `^${MCP_API_KEY_PREFIX}`
        + "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}"
        + "-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[A-Za-z0-9_-]{43}$",
        "iu",
      ),
      "The MCP API key file does not contain a valid CiteLoom MCP key.",
    )
    .parse(value);
}

function readMcpClientSecretFile(path: string): string {
  return readFileSync(path, "utf8");
}

function readIntegerOption(
  values: Map<string, string>,
  name: string,
  defaultValue: number,
): number {
  const value = values.get(name);
  if (value === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`MCP client option ${name} must be an integer.`);
  }
  return Number(value);
}

function readMcpServerUrl(value: string): string {
  const url = readUrl(value, "MCP server URL");
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!secure && !localHttp) {
    throw new Error(
      "The MCP server URL must use HTTPS, except for loopback HTTP testing.",
    );
  }
  if (url.pathname === "/") {
    throw new Error("The MCP server URL must include its endpoint path.");
  }
  return url.toString();
}

function readLoopbackCallbackUrl(value: string): string {
  const url = readUrl(value, "OAuth callback URL");
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
    throw new Error("The OAuth callback URL must use loopback HTTP.");
  }
  if (url.port === "") {
    throw new Error("The OAuth callback URL must include an explicit port.");
  }
  return url.toString();
}

function readUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The ${label} is invalid.`);
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error(
      `The ${label} must not contain credentials, a query, or a fragment.`,
    );
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}
