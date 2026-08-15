import {
  MCP_ANSWER_SCOPE,
  MCP_ANSWER_CANCEL_TOOL,
  MCP_ANSWER_STATUS_TOOL,
  MCP_ANSWER_TOOL,
  MCP_CITATION_RESOURCE_TEMPLATE,
  MCP_SEARCH_SCOPE,
  MCP_SEARCH_TOOL,
  MCP_THREAD_RESOURCE_TEMPLATE,
  MCP_WORKSPACE_CONTEXT_RESOURCE,
} from "./mcp.js";

export function buildMcpServerInstructions(
  grantedScopes: readonly string[],
): string {
  const scopes = new Set(grantedScopes);
  const instructions = [
    "CiteLoom is a domain-agnostic retrieval-augmented generation server for the combined document set available to the authenticated user.",
    `Use the ${MCP_WORKSPACE_CONTEXT_RESOURCE} content supplied by the MCP host to confirm the active user and available workspaces.`,
    "Use only the capabilities made available by the MCP host for the current credential. CiteLoom filters them by granted scope and current workspace membership.",
  ];
  if (scopes.has(MCP_SEARCH_SCOPE)) {
    instructions.push(
      `Use ${MCP_SEARCH_TOOL} to retrieve exact and optionally related passages without creating a saved research turn.`,
      "The tool performs one search over the combined authorized document set.",
      "Choose one query scope: all documents, document IDs, source-file names, or tags.",
      "Preserve returned document, passage, source-file, page, section, and region metadata when presenting search evidence.",
    );
  }
  if (scopes.has(MCP_ANSWER_SCOPE)) {
    instructions.push(
      `Use ${MCP_ANSWER_TOOL} when the user wants cited answers saved as research turns.`,
      "The task performs one retrieval and creates one answer over the combined authorized document set.",
      `The tool returns a durable task handle. Call ${MCP_ANSWER_STATUS_TOOL} with its task ID after the stated poll interval until the status is completed, failed, or cancelled.`,
      `Use ${MCP_ANSWER_CANCEL_TOOL} only when the user asks to stop an answer task.`,
      "Do not treat a working task handle as an answer. Use only the cited answer from a completed status result.",
      `A completed result can link a saved thread at ${MCP_THREAD_RESOURCE_TEMPLATE} and immutable citation evidence at ${MCP_CITATION_RESOURCE_TEMPLATE}; use resource content supplied by the host and never invent resource identifiers.`,
    );
  }
  return instructions.join("\n");
}

export function buildMcpSearchPrompt(query: string): string {
  const instructions = [
    `Use the ${MCP_SEARCH_TOOL} tool to search the combined document set available to the authenticated user for the query below.`,
    "Use the all-documents scope unless the user has supplied a narrower document, source-file, or tag scope.",
    "Report the relevant passages and preserve their source file, page numbers, section path, and document and passage identifiers.",
    "Do not claim that a source supports a statement when the returned passage does not support it.",
    "",
    "<query>",
    query,
    "</query>",
  ];
  return instructions.join("\n");
}

export function buildMcpAnswerPrompt(
  question: string,
  threadTitle: string,
): string {
  const instructions = [
    `Use the ${MCP_ANSWER_TOOL} tool to create one answer from the combined document set available to the authenticated user and save the result under the requested thread title.`,
    "Use the all-documents scope unless the user has supplied a narrower document, source-file, or tag scope.",
    `The tool returns a durable task handle. Call ${MCP_ANSWER_STATUS_TOOL} with its task ID after the stated poll interval until the task reaches a final status.`,
    "Do not treat the initial task handle as an answer. Use only the cited answer from a completed status result.",
    "When the task completes, present the cited answer.",
    "Do not invent citations or resource identifiers.",
    "",
    "<thread-title>",
    threadTitle,
    "</thread-title>",
    "<question>",
    question,
    "</question>",
  ];
  return instructions.join("\n");
}
