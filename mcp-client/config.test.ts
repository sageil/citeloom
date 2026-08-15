import { describe, expect, it } from "vitest";

import { readMcpClientCommand } from "./config.js";

const validArguments = [
  "--server-url",
  "https://citeloom.example/mcp",
  "--client-id",
  "native-client",
  "--callback-url",
  "http://127.0.0.1:6276/oauth/callback",
  "--workspace",
  "DefaultSpace",
  "--question",
  "What is the retention policy?",
];

describe("MCP client command boundary", () => {
  it("normalizes a complete host-side smoke command", () => {
    expect(readMcpClientCommand(["--", ...validArguments])).toEqual({
      config: {
        authentication: {
          callbackUrl: "http://127.0.0.1:6276/oauth/callback",
          clientId: "native-client",
          kind: "oauth",
        },
        caFile: null,
        pollIntervalMs: 1_000,
        question: "What is the retention policy?",
        serverUrl: "https://citeloom.example/mcp",
        timeoutMs: 600_000,
        workspaceName: "DefaultSpace",
      },
      kind: "run",
    });
  });

  it("reads an API key file with its selected workspace", () => {
    const apiKey = "clm_mcp_00000000-0000-4000-8000-000000000001."
      + "a".repeat(43);
    const readSecretFile = (path: string) => {
      expect(path).toBe("/run/secrets/citeloom-mcp-key");
      return `${apiKey}\n`;
    };
    expect(readMcpClientCommand([
      "--server-url",
      "https://citeloom.example/mcp",
      "--api-key-file",
      "/run/secrets/citeloom-mcp-key",
      "--workspace",
      "DefaultSpace",
      "--question",
      "What is the retention policy?",
    ], readSecretFile)).toEqual({
      config: {
        authentication: { apiKey, kind: "api-key" },
        caFile: null,
        pollIntervalMs: 1_000,
        question: "What is the retention policy?",
        serverUrl: "https://citeloom.example/mcp",
        timeoutMs: 600_000,
        workspaceName: "DefaultSpace",
      },
      kind: "run",
    });
  });

  it("rejects an invalid API key file", () => {
    expect(() => readMcpClientCommand([
      "--server-url",
      "https://citeloom.example/mcp",
      "--api-key-file",
      "/run/secrets/citeloom-mcp-key",
      "--workspace",
      "DefaultSpace",
      "--question",
      "What is the retention policy?",
    ], () => "not-a-key")).toThrow(
      "The MCP API key file does not contain a valid CiteLoom MCP key.",
    );
  });

  it("requires a workspace with an API key", () => {
    const apiKey = "clm_mcp_00000000-0000-4000-8000-000000000001."
      + "a".repeat(43);
    expect(() => readMcpClientCommand([
      "--server-url",
      "https://citeloom.example/mcp",
      "--api-key-file",
      "/run/secrets/citeloom-mcp-key",
      "--question",
      "What is the retention policy?",
    ], () => apiKey)).toThrow(
      "Missing required MCP client option --workspace.",
    );
  });

  it("accepts an explicit private CA file", () => {
    expect(readMcpClientCommand([
      ...validArguments,
      "--ca-file",
      "/deployment/caddy-root.crt",
    ])).toMatchObject({
      config: { caFile: "/deployment/caddy-root.crt" },
      kind: "run",
    });
  });

  it("rejects missing deployment-specific values", () => {
    expect(() => readMcpClientCommand([])).toThrow(
      "Missing required MCP client option --question.",
    );
  });

  it("rejects a non-loopback OAuth callback", () => {
    const argumentsWithExternalCallback = [...validArguments];
    const callbackIndex = argumentsWithExternalCallback.indexOf(
      "http://127.0.0.1:6276/oauth/callback",
    );
    argumentsWithExternalCallback[callbackIndex] =
      "https://external.example/oauth/callback";

    expect(() => readMcpClientCommand(argumentsWithExternalCallback)).toThrow(
      "The OAuth callback URL must use loopback HTTP.",
    );
  });
});
