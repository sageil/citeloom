import {
  MCP_ANSWER_SCOPE,
  MCP_ANSWER_TOOL,
  MCP_CITATION_RESOURCE_TEMPLATE,
  MCP_SEARCH_SCOPE,
  MCP_SEARCH_TOOL,
  MCP_THREAD_RESOURCE_TEMPLATE,
  MCP_WORKSPACE_CONTEXT_RESOURCE,
} from "./contract.js";

export function buildMcpServerInstructions(
  grantedScopes: readonly string[],
): string {
  const scopes = new Set(grantedScopes);
  const instructions = [
    "CiteLoom is a domain-agnostic retrieval-augmented generation server for the authenticated CiteLoom workspace.",
    `Use the ${MCP_WORKSPACE_CONTEXT_RESOURCE} content supplied by the MCP host to confirm the active user and workspace.`,
    "Use only the capabilities made available by the MCP host for the current credential; CiteLoom filters them by granted scope and local workspace authorization.",
  ];
  if (scopes.has(MCP_SEARCH_SCOPE)) {
    instructions.push(
      `Use ${MCP_SEARCH_TOOL} to retrieve exact and optionally related passages without creating a saved research turn.`,
      "Choose one query scope: all documents, document IDs, source-file names, or tags.",
      "Preserve returned document, passage, source-file, page, section, and region metadata when presenting search evidence.",
    );
  }
  if (scopes.has(MCP_ANSWER_SCOPE)) {
    instructions.push(
      `Use ${MCP_ANSWER_TOOL} when the user wants a synthesized cited answer saved as a research turn.`,
      "This tool requires host support for the io.modelcontextprotocol/tasks extension and initially returns a durable task handle; do not treat that handle as the answer.",
      "Use only the completed answer result supplied after the MCP host resolves the task.",
      `A completed task can link a saved thread at ${MCP_THREAD_RESOURCE_TEMPLATE} and immutable citation evidence at ${MCP_CITATION_RESOURCE_TEMPLATE}; use resource content supplied by the host and never invent resource identifiers.`,
    );
  }
  return instructions.join("\n");
}

export function buildMcpSearchPrompt(query: string): string {
  const instructions = [
    `Use the ${MCP_SEARCH_TOOL} tool to search the selected CiteLoom workspace for the query below.`,
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
    `Use the ${MCP_ANSWER_TOOL} tool to answer the question below from the selected CiteLoom workspace and save the result under the requested thread title.`,
    "Use the all-documents scope unless the user has supplied a narrower document, source-file, or tag scope.",
    "The MCP host resolves the asynchronous task; do not treat the initial task handle as an answer.",
    "Use only the completed answer result supplied by the host.",
    "When the task completes, present the cited answer and use thread or citation resource content supplied by the host when the user needs saved context or underlying evidence.",
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
