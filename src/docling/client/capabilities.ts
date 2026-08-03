import { createHash } from "node:crypto";

import { z } from "zod";

import { DOCLING_SERVE_VERSION } from "../protocol/model.js";

const openApiSchema = z.object({
  components: z.object({
    schemas: z.record(z.string(), z.unknown()),
  }).loose(),
  info: z.object({
    title: z.literal("Docling Serve"),
    version: z.literal(DOCLING_SERVE_VERSION),
  }).loose(),
  openapi: z.string().min(1),
  paths: z.record(z.string(), z.unknown()),
}).loose();

const requiredFields = [
  "abort_on_error",
  "do_ocr",
  "do_table_structure",
  "document_timeout",
  "force_ocr",
  "from_formats",
  "image_export_mode",
  "images_scale",
  "include_images",
  "include_page_images",
  "ocr_preset",
  "pdf_backend",
  "pipeline",
  "table_cell_matching",
  "table_mode",
  "to_formats",
  "vlm_pipeline_custom_config",
] as const;
const requiredContentFields = [
  "byte_length",
  "document_id",
  "filename",
  "options",
  "task_id",
] as const;
const requiredPdfBackends = [
  "docling_parse",
  "pypdfium2",
  "threaded_docling_parse",
] as const;
const requiredPipelines = ["standard", "vlm"] as const;
const enumSchema = z.object({
  enum: z.array(z.string().min(1)).min(1),
}).loose();

export interface DoclingCapabilityIdentity {
  fingerprint: string;
}

export function decodeDoclingCapabilities(
  value: unknown,
): DoclingCapabilityIdentity {
  const result = openApiSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling OpenAPI document: ${result.error.message}`);
  }
  requirePath(result.data.paths, "/v1/convert/content/async", "post");
  requirePath(result.data.paths, "/v1/result/{task_id}", "get");
  requirePath(result.data.paths, "/v1/status/poll/{task_id}", "get");
  requirePath(result.data.paths, "/v1/tasks/{task_id}/pause", "post");
  requirePath(result.data.paths, "/v1/tasks/{task_id}/terminate", "post");
  const requestProperties = readContentRequestProperties(
    result.data.paths,
    result.data.components.schemas,
  );
  for (const field of requiredContentFields) {
    if (!(field in requestProperties)) {
      throw new Error(`Docling content conversion is missing ${field}.`);
    }
  }
  const optionsSchema = resolveComponentSchema(
    requestProperties.options,
    result.data.components.schemas,
    "Docling content conversion options",
  );
  const properties = readObject(
    optionsSchema.properties,
    "Docling content conversion option properties",
  );
  for (const field of requiredFields) {
    if (!(field in properties)) {
      throw new Error(`Docling async conversion is missing ${field}.`);
    }
  }
  const advertisedBackends = readSchemaEnum(
    properties.pdf_backend,
    result.data.components.schemas,
    "Docling pdf_backend",
  );
  for (const backend of requiredPdfBackends) {
    if (!advertisedBackends.has(backend)) {
      throw new Error(`Docling OpenAPI does not advertise ${backend}.`);
    }
  }
  const advertisedPipelines = readSchemaEnum(
    properties.pipeline,
    result.data.components.schemas,
    "Docling pipeline",
  );
  for (const pipeline of requiredPipelines) {
    if (!advertisedPipelines.has(pipeline)) {
      throw new Error(`Docling OpenAPI does not advertise ${pipeline}.`);
    }
  }
  return {
    fingerprint: createHash("sha256")
      .update(stableSerialize(value))
      .digest("hex"),
  };
}

function readSchemaEnum(
  value: unknown,
  schemas: { [key: string]: unknown },
  name: string,
): Set<string> {
  let schema = readObject(value, `${name} schema`);
  if (typeof schema.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix)) {
      throw new Error(`${name} uses an unsupported reference.`);
    }
    const componentName = schema.$ref.slice(prefix.length);
    schema = readObject(
      schemas[componentName],
      `${name} component`,
    );
  }
  const result = enumSchema.safeParse(schema);
  if (!result.success) {
    throw new Error(
      `${name} enum is invalid: ${result.error.message}`,
    );
  }
  return new Set(result.data.enum);
}

function requirePath(
  paths: { [key: string]: unknown },
  path: string,
  method: string,
): void {
  const pathValue = readObject(paths[path], `Docling path ${path}`);
  if (!(method in pathValue)) {
    throw new Error(`Docling OpenAPI is missing ${method.toUpperCase()} ${path}.`);
  }
}

function readContentRequestProperties(
  paths: { [key: string]: unknown },
  schemas: { [key: string]: unknown },
): { [key: string]: unknown } {
  const path = readObject(
    paths["/v1/convert/content/async"],
    "Docling content conversion path",
  );
  const post = readObject(path.post, "Docling content conversion operation");
  const requestBody = readObject(post.requestBody, "Docling request body");
  const content = readObject(requestBody.content, "Docling request content");
  const json = readObject(
    content["application/json"],
    "Docling JSON content",
  );
  const schema = resolveComponentSchema(
    json.schema,
    schemas,
    "Docling content request",
  );
  return readObject(schema.properties, "Docling content request properties");
}

function resolveComponentSchema(
  value: unknown,
  schemas: { [key: string]: unknown },
  name: string,
): { [key: string]: unknown } {
  const schema = readObject(value, `${name} schema`);
  const reference = schema.$ref;
  if (typeof reference !== "string") {
    return schema;
  }
  const prefix = "#/components/schemas/";
  if (!reference.startsWith(prefix)) {
    throw new Error(`${name} schema uses an unsupported reference.`);
  }
  const componentName = reference.slice(prefix.length);
  return readObject(
    schemas[componentName],
    `${name} component`,
  );
}

function readObject(
  value: unknown,
  name: string,
): { [key: string]: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is not an object.`);
  }
  return value as { [key: string]: unknown };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const object = value as { [key: string]: unknown };
  const fields: string[] = [];
  for (const key of Object.keys(object).sort()) {
    fields.push(`${JSON.stringify(key)}:${stableSerialize(object[key])}`);
  }
  return `{${fields.join(",")}}`;
}
