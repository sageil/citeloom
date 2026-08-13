import type { FetchLike } from "@modelcontextprotocol/client";

import { MCP_WORKSPACE_NAME_HEADER } from "../src/mcp/contract.js";

export function createMcpRequestFetch(
  serverUrlValue: string,
  workspaceName: string | null,
  fetchImplementation: FetchLike = fetch,
): FetchLike {
  const serverUrl = new URL(serverUrlValue).toString();
  return async (input, init) => {
    if (readRequestUrl(input).toString() !== serverUrl) {
      return fetchImplementation(input, init);
    }
    const headers = new Headers(init?.headers);
    if (workspaceName !== null) {
      headers.set(MCP_WORKSPACE_NAME_HEADER, workspaceName);
    }
    return fetchImplementation(input, { ...init, headers });
  };
}

function readRequestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input);
}
