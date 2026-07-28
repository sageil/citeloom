import { createHash } from "node:crypto";

import { z } from "zod";

export const EMBEDDING_INPUT_FORMAT_SCHEMA_VERSION = 1;
export const EMBEDDING_INPUT_TEXT_PLACEHOLDER = "{{text}}";
export const BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS = {
  embeddingGemma: "00000000-0000-4000-8000-000000000002",
  plain: "00000000-0000-4000-8000-000000000001",
  snowflake: "00000000-0000-4000-8000-000000000003",
} as const;

const inputFormatTemplateSchema = z.string()
  .min(EMBEDDING_INPUT_TEXT_PLACEHOLDER.length)
  .max(10_000)
  .superRefine((template, context) => {
    if (countTextPlaceholders(template) !== 1) {
      context.addIssue({
        code: "custom",
        message: `must contain exactly one ${EMBEDDING_INPUT_TEXT_PLACEHOLDER} placeholder`,
      });
    }
  });
const embeddingInputFormatDefinitionSchema = z.object({
  documentTemplate: inputFormatTemplateSchema,
  name: z.string().trim().min(1).max(100),
  queryTemplate: inputFormatTemplateSchema,
  schemaVersion: z.number().int().positive(),
}).strict();
const embeddingInputFormatContractSchema =
  embeddingInputFormatDefinitionSchema.extend({
    id: z.uuid(),
    inputFormatHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().superRefine((format, context) => {
    const expectedHash = createEmbeddingInputFormatHash(format);
    if (format.inputFormatHash !== expectedHash) {
      context.addIssue({
        code: "custom",
        message: "does not match the input-format templates and schema version",
        path: ["inputFormatHash"],
      });
    }
  });

export type EmbeddingInputFormatDefinition = z.infer<
  typeof embeddingInputFormatDefinitionSchema
>;
export type EmbeddingInputFormatContract = z.infer<
  typeof embeddingInputFormatContractSchema
>;

export function createEmbeddingInputFormatHash(
  value: Pick<
    EmbeddingInputFormatDefinition,
    "documentTemplate" | "queryTemplate" | "schemaVersion"
  >,
): string {
  const definition = readEmbeddingInputFormatDefinition({
    documentTemplate: value.documentTemplate,
    name: "Hash input",
    queryTemplate: value.queryTemplate,
    schemaVersion: value.schemaVersion,
  });
  const serialized = [
    "citeloom/embedding-input-format",
    definition.schemaVersion,
    definition.documentTemplate,
    definition.queryTemplate,
  ].join("\0");
  return createHash("sha256").update(serialized).digest("hex");
}

export function createEmbeddingInputFormatContract(
  id: string,
  value: EmbeddingInputFormatDefinition,
): EmbeddingInputFormatContract {
  const definition = readEmbeddingInputFormatDefinition(value);
  return readEmbeddingInputFormatContract({
    ...definition,
    id,
    inputFormatHash: createEmbeddingInputFormatHash(definition),
  });
}

export function readEmbeddingInputFormatDefinition(
  value: unknown,
): EmbeddingInputFormatDefinition {
  const result = embeddingInputFormatDefinitionSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid embedding input format: ${result.error.message}`);
  }
  return result.data;
}

export function readEmbeddingInputFormatContract(
  value: unknown,
): EmbeddingInputFormatContract {
  const result = embeddingInputFormatContractSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid embedding input-format contract: ${result.error.message}`,
    );
  }
  return result.data;
}

function countTextPlaceholders(template: string): number {
  let count = 0;
  let position = 0;
  while (position < template.length) {
    const match = template.indexOf(EMBEDDING_INPUT_TEXT_PLACEHOLDER, position);
    if (match < 0) {
      break;
    }
    count += 1;
    position = match + EMBEDDING_INPUT_TEXT_PLACEHOLDER.length;
  }
  return count;
}
