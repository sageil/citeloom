import {
  EMBEDDING_INPUT_TEXT_PLACEHOLDER,
  type EmbeddingInputFormatContract,
} from "./input-format-model.js";

export {
  BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS,
  createEmbeddingInputFormatContract,
  createEmbeddingInputFormatHash,
  EMBEDDING_INPUT_FORMAT_SCHEMA_VERSION,
  EMBEDDING_INPUT_TEXT_PLACEHOLDER,
  readEmbeddingInputFormatContract,
  readEmbeddingInputFormatDefinition,
  type EmbeddingInputFormatContract,
  type EmbeddingInputFormatDefinition,
} from "./input-format-model.js";

export function formatDocumentEmbeddingText(
  inputFormat: EmbeddingInputFormatContract,
  content: string,
): string {
  return renderEmbeddingInputTemplate(inputFormat.documentTemplate, content);
}

export function formatQueryEmbeddingText(
  inputFormat: EmbeddingInputFormatContract,
  query: string,
): string {
  return renderEmbeddingInputTemplate(inputFormat.queryTemplate, query);
}

function renderEmbeddingInputTemplate(template: string, text: string): string {
  return template.replace(EMBEDDING_INPUT_TEXT_PLACEHOLDER, text);
}
