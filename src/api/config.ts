import { resolve } from "node:path";

import { z } from "zod";
import type { WebRuntimeConfig } from "../config/index.js";

const webEnvironmentSchema = z.object({
  CITELOOM_UPLOAD_DIRECTORY: z.string().trim().min(1).default("documents/uploads"),
  CITELOOM_WEB_HOST: z.string().trim().min(1).default("127.0.0.1"),
  CITELOOM_WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
});

export interface WebStartupConfig {
  host: string;
  port: number;
  uploadDirectory: string;
}

export interface WebConfig extends WebRuntimeConfig, WebStartupConfig {}

export function readWebStartupConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WebStartupConfig {
  const result = webEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map(formatWebConfigIssue).join("\n");
    throw new Error(`Invalid web configuration:\n${details}`);
  }

  return {
    host: result.data.CITELOOM_WEB_HOST,
    port: result.data.CITELOOM_WEB_PORT,
    uploadDirectory: resolve(result.data.CITELOOM_UPLOAD_DIRECTORY),
  };
}

export function buildWebConfig(
  runtime: WebRuntimeConfig,
  startup: WebStartupConfig = readWebStartupConfig(),
): WebConfig {
  return { ...runtime, ...startup };
}

function formatWebConfigIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? "environment" : issue.path.join(".");
  return `- ${path}: ${issue.message}`;
}
