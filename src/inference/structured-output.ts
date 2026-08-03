import type { JSONSchema7 } from "@ai-sdk/provider";
import { jsonSchema, Output } from "ai";
import { z } from "zod";

interface StructuredOutputContract<OutputValue> {
  description: string;
  name: string;
  schema: z.ZodType<OutputValue>;
  validation: "local" | "provider-only";
}

export function createStructuredOutput<OutputValue>(
  contract: StructuredOutputContract<OutputValue>,
): ReturnType<typeof Output.object<OutputValue>> {
  const providerSchema = z.toJSONSchema(contract.schema) as JSONSchema7;
  assertProviderCompatibleSchema(contract.name, providerSchema);
  const schema = contract.validation === "local"
    ? jsonSchema<OutputValue>(providerSchema, {
      validate: (value) => validateStructuredOutput(contract, value),
    })
    : jsonSchema<OutputValue>(providerSchema);
  return Output.object({
    description: contract.description,
    name: contract.name,
    schema,
  });
}

function validateStructuredOutput<OutputValue>(
  contract: StructuredOutputContract<OutputValue>,
  value: unknown,
) {
  const result = contract.schema.safeParse(value);
  if (result.success) {
    return { success: true as const, value: result.data };
  }
  return {
    error: new Error(
      `Invalid ${contract.name} structured output: ${result.error.message}`,
    ),
    success: false as const,
  };
}

function assertProviderCompatibleSchema(
  name: string,
  schema: JSONSchema7,
): void {
  if (schema.type !== "object") {
    throw new Error(
      `Structured output ${name} must use an object at the schema root.`,
    );
  }
  if (schema.additionalProperties !== false) {
    throw new Error(
      `Structured output ${name} must reject additional root properties.`,
    );
  }
  const paths = findSchemaKeywordPaths(schema, "oneOf");
  if (paths.length > 0) {
    throw new Error(
      `Structured output ${name} uses unsupported oneOf at ${paths.join(", ")}.`,
    );
  }
}

function findSchemaKeywordPaths(value: unknown, keyword: string): string[] {
  const matches: string[] = [];
  const pending: Array<{ path: string; value: unknown }> = [{
    path: "$",
    value,
  }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        pending.push({
          path: `${current.path}[${index}]`,
          value: current.value[index],
        });
      }
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) {
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      const path = `${current.path}.${key}`;
      if (key === keyword) {
        matches.push(path);
      }
      pending.push({ path, value: child });
    }
  }
  return matches.sort();
}
