import { resolve } from "node:path";

import { z } from "zod";

const webEnvironmentSchema = z.object({
  CITELOOM_MAX_UPLOAD_REQUEST_MEGABYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(100),
  CITELOOM_PUBLIC_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "must use http or https").default("https://localhost:3443"),
  CITELOOM_SECURE_SESSION_COOKIE: z.enum(["true", "false"]).default("true"),
  CITELOOM_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  CITELOOM_UPLOAD_DIRECTORY: z.string().trim().min(1).default("documents/uploads"),
  CITELOOM_WEB_HOST: z.string().trim().min(1).default("127.0.0.1"),
  CITELOOM_WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
});

export interface WebConfig {
  host: string;
  maximumUploadRequestBytes: number;
  port: number;
  publicOrigin: string;
  secureSessionCookie: boolean;
  trustProxy: boolean;
  uploadDirectory: string;
}

export function readWebConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WebConfig {
  const result = webEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map(formatWebConfigIssue).join("\n");
    throw new Error(`Invalid web configuration:\n${details}`);
  }

  return {
    host: result.data.CITELOOM_WEB_HOST,
    maximumUploadRequestBytes:
      result.data.CITELOOM_MAX_UPLOAD_REQUEST_MEGABYTES * 1_024 * 1_024,
    port: result.data.CITELOOM_WEB_PORT,
    publicOrigin: result.data.CITELOOM_PUBLIC_ORIGIN,
    secureSessionCookie: result.data.CITELOOM_SECURE_SESSION_COOKIE === "true",
    trustProxy: result.data.CITELOOM_TRUST_PROXY === "true",
    uploadDirectory: resolve(result.data.CITELOOM_UPLOAD_DIRECTORY),
  };
}

function formatWebConfigIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? "environment" : issue.path.join(".");
  return `- ${path}: ${issue.message}`;
}
