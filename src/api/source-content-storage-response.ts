import type { SourceContentConfig } from "../config/index.js";
import type {
  SourceContentMigrationRecord,
  SourceContentStorageOverview,
} from "../documents/storage/source-content-migration-store.js";

export type SourceContentConfigResponse =
  | {
      directory: string;
      kind: "filesystem";
    }
  | {
      bucket: string;
      credentialSource: "environment" | "static";
      credentialsConfigured: boolean;
      endpointUrl: string;
      forcePathStyle: boolean;
      kind: "s3";
      prefix: string;
      region: string;
    };

export interface SourceContentMigrationResponse {
  attemptCount: number;
  completedAt: string | null;
  copiedDocuments: number;
  createdAt: string;
  errorMessage: string | null;
  id: string;
  source: SourceContentConfigResponse;
  startedAt: string | null;
  state:
    | "queued"
    | "validating"
    | "copying"
    | "cutover"
    | "cancel_requested"
    | "completed"
    | "failed"
    | "cancelled";
  target: SourceContentConfigResponse;
  totalDocuments: number;
  updatedAt: string;
  verifiedDocuments: number;
}

export interface SourceContentStorageResponse {
  active: SourceContentConfigResponse;
  documentCount: number;
  migration: SourceContentMigrationResponse | null;
  settingsVersion: number;
}

export function buildSourceContentStorageResponse(
  overview: SourceContentStorageOverview,
): SourceContentStorageResponse {
  return {
    active: presentSourceContentConfig(overview.activeConfig),
    documentCount: overview.documentCount,
    migration: overview.migration === null
      ? null
      : presentSourceContentMigration(overview.migration),
    settingsVersion: overview.settingsVersion,
  };
}

export function presentSourceContentMigration(
  migration: SourceContentMigrationRecord,
): SourceContentMigrationResponse {
  return {
    attemptCount: migration.attemptCount,
    completedAt: migration.completedAt?.toISOString() ?? null,
    copiedDocuments: migration.copiedDocuments,
    createdAt: migration.createdAt.toISOString(),
    errorMessage: migration.errorMessage,
    id: migration.id,
    source: presentSourceContentConfig(migration.sourceConfig),
    startedAt: migration.startedAt?.toISOString() ?? null,
    state: migration.state,
    target: presentSourceContentConfig(migration.targetConfig),
    totalDocuments: migration.totalDocuments,
    updatedAt: migration.updatedAt.toISOString(),
    verifiedDocuments: migration.verifiedDocuments,
  };
}

export function presentSourceContentConfig(
  config: SourceContentConfig,
): SourceContentConfigResponse {
  if (config.kind === "filesystem") {
    return {
      directory: config.directory,
      kind: "filesystem",
    };
  }
  return {
    bucket: config.bucket,
    credentialSource: config.credentials.kind,
    credentialsConfigured: config.credentials.kind === "static",
    endpointUrl: config.endpointUrl,
    forcePathStyle: config.forcePathStyle,
    kind: "s3",
    prefix: config.prefix,
    region: config.region,
  };
}
