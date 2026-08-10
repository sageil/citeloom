import type { SourceContentConfig } from "../../config/index.js";
import { FilesystemSourceContentBackend } from "./filesystem-source-content-backend.js";
import { S3SourceContentBackend } from "./s3-source-content-backend.js";
import type { SourceContentBackend } from "./source-content-backend-contract.js";

export * from "./source-content-backend-contract.js";

export function createSourceContentBackend(
  config: SourceContentConfig,
): SourceContentBackend {
  if (config.kind === "filesystem") {
    return new FilesystemSourceContentBackend(config);
  }
  return new S3SourceContentBackend(config);
}
