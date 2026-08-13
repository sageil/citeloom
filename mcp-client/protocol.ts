import { MCP_TASK_EXTENSION_ID } from "../src/mcp/tasks/model.js";

export const MCP_SMOKE_CLIENT_INFO = {
  name: "citeloom-mcp-smoke-client",
  version: "1.0.0",
} as const;

export function buildMcpSmokeClientCapabilities() {
  return {
    extensions: { [MCP_TASK_EXTENSION_ID]: {} },
  };
}

export function buildMcpSmokeRequestMeta(protocolVersion: string) {
  return {
    "io.modelcontextprotocol/clientCapabilities":
      buildMcpSmokeClientCapabilities(),
    "io.modelcontextprotocol/clientInfo": MCP_SMOKE_CLIENT_INFO,
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
  };
}
