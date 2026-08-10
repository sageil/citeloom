import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  halfvec,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  varchar,
} from "drizzle-orm/pg-core";
import type { ExtraConfigColumn } from "drizzle-orm/pg-core";

import type { StoredDoclingArtifact } from "../docling/protocol/index.js";
import type {
  DoclingAttemptConfigSnapshot,
  DoclingEffectiveRequestOptions,
  DoclingProcessConfiguration,
  DoclingServiceIdentity,
} from "../docling/protocol/run-metadata.js";
import type { StoredApplicationSettings } from "../providers/settings-persistence.js";
import type { SourceContentConfig } from "../config/types.js";
import type { MatchedDocument } from "../retrieval/document-retrieval.js";
import type { EmbeddingSpaceRowCounts } from "../embedding/space/types.js";
import { EMBEDDING_DIMENSIONS } from "../embedding/dimensions.js";
import type { QueryScope } from "../domain/query-scope.js";
import type {
  CitationEvidence,
  ResearchRetrievalTrace,
  StoredResearchRetrievalTrace,
  ResearchRunConfiguration,
} from "../research/types.js";
import type {
  AnswerBudgetTelemetry,
  CandidateBudgetTelemetry,
  ContextSelectionTelemetry,
} from "../observability/run.js";
import type {
  ChatClaimVerificationResult,
  ChatMemoryTrace,
  ChatRunConfiguration,
} from "../chat/types.js";
import type { PublishedAnswerDocument } from "../answers/published.js";
import type {
  RetrievalSourceElement,
  SourceRegion,
} from "../domain/source-elements.js";
import type {
  RetrievalDescriptionRecord,
} from "../domain/retrieval-descriptions.js";
import type { DocumentTocArtifact } from "../domain/document-toc.js";
import type { StoredRetrievalWindowPolicy } from "../retrieval/window-policy.js";

export const ingestionPhase = pgEnum("ingestion_phase", [
  "discovered",
  "normalized",
  "indexed",
]);

export const ingestionIndexingActivity = pgEnum("ingestion_indexing_activity", [
  "preparing",
  "describing",
  "embedding",
  "building_outline",
]);

export const ingestionState = pgEnum("ingestion_state", [
  "pending",
  "running",
  "failed",
]);

export const ingestionControlState = pgEnum("ingestion_control_state", [
  "active",
  "pause_requested",
  "paused",
  "cancel_requested",
  "cleanup_failed",
]);

export const doclingServiceState = pgEnum("docling_service_state", [
  "active",
  "unavailable",
  "draining",
]);

export const elementKind = pgEnum("element_kind", ["text", "table", "image"]);

export const answerPresentation = pgEnum("answer_presentation", [
  "paragraph",
  "bullet",
]);

export const answerSection = pgEnum("answer_section", [
  "answer",
  "key-points",
  "conflicting-evidence",
]);

export const claimSupportStatus = pgEnum("claim_support_status", [
  "partially-supported",
  "supported",
  "unsupported",
  "unverified",
]);

export const verificationOutcome = pgEnum("verification_outcome", [
  "not-evaluated",
  "supported",
  "unsupported",
  "verifier-incompatible",
]);

export const researchOutputState = pgEnum("research_output_state", [
  "building",
  "published",
]);

export const chatMessageRole = pgEnum("chat_message_role", [
  "user",
  "assistant",
]);

export const chatRunState = pgEnum("chat_run_state", [
  "accepted",
  "embedding",
  "retrieving",
  "generating",
  "verifying",
  "publishing",
  "completed",
  "failed",
  "canceled",
]);

export const chatVerificationJobState = pgEnum(
  "chat_verification_job_state",
  [
    "pending",
    "running",
    "completed",
    "failed",
  ],
);

export const researchVerificationJobState = pgEnum(
  "research_verification_job_state",
  [
    "pending",
    "running",
    "completed",
    "failed",
  ],
);

export const inferenceWorkload = pgEnum("inference_workload", [
  "offline-tool",
  "ingestion",
  "interactive-answer",
  "interactive-search",
  "maintenance",
]);

export const workerState = pgEnum("worker_state", [
  "starting",
  "idle",
  "working",
  "stopped",
]);

export const applicationErrorSeverity = pgEnum("application_error_severity", [
  "warning",
  "error",
  "critical",
]);

export const applicationErrorOrigin = pgEnum("application_error_origin", [
  "http-request",
  "streaming-answer",
  "ingestion",
  "inference-provider",
  "worker",
  "scheduler",
  "background-task",
  "settings-reload",
  "database-operation",
  "startup",
  "cli",
  "docling-transport",
  "docling-task",
  "docling-conversion",
  "docling-normalization",
  "docling-element",
]);

export const telemetryRunKind = pgEnum("telemetry_run_kind", [
  "answer",
  "benchmark",
  "chat",
  "retrieval",
  "search",
]);

export const telemetryRunOutcome = pgEnum("telemetry_run_outcome", [
  "success",
  "error",
  "abort",
]);

export const telemetryStageOutcome = pgEnum("telemetry_stage_outcome", [
  "success",
  "error",
  "abort",
  "fallback",
]);

export const userAccountState = pgEnum("user_account_state", [
  "active",
  "pending",
  "suspended",
]);

export const workspaceRole = pgEnum("workspace_role", ["admin", "member"]);

export const users = pgTable(
  "users",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    displayName: text("display_name").notNull(),
    id: uuid("id").primaryKey(),
    state: userAccountState("state").notNull().default("pending"),
    username: varchar("username", { length: 100 }).notNull(),
    usernameNormalized: varchar("username_normalized", { length: 100 }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_username_normalized_idx").on(table.usernameNormalized),
    check(
      "users_username_normalized_check",
      sql`${table.usernameNormalized} = lower(${table.usernameNormalized}) AND length(trim(${table.usernameNormalized})) > 0`,
    ),
  ],
);

export const userPasswordCredentials = pgTable("user_password_credentials", {
  passwordHash: text("password_hash").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const workspaces = pgTable(
  "workspaces",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspaces_slug_idx").on(table.slug),
    check(
      "workspaces_slug_check",
      sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
  ],
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    role: workspaceRole("role").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_memberships_user_idx").on(table.userId, table.workspaceId),
  ],
);

export const workspaceSecurityPolicies = pgTable(
  "workspace_security_policies",
  {
    minimumPasswordLength: integer("minimum_password_length")
      .notNull()
      .default(15),
    requireLetterAndNumber: boolean("require_letter_and_number")
      .notNull()
      .default(false),
    requireSpecialCharacter: boolean("require_special_character")
      .notNull()
      .default(false),
    resetLinkLifetimeSeconds: integer("reset_link_lifetime_seconds")
      .notNull()
      .default(86_400),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "workspace_security_policies_minimum_password_length_check",
      sql`${table.minimumPasswordLength} BETWEEN 9 AND 64`,
    ),
    check(
      "workspace_security_policies_reset_link_lifetime_check",
      sql`${table.resetLinkLifetimeSeconds} BETWEEN 900 AND 604800`,
    ),
    check(
      "workspace_security_policies_version_check",
      sql`${table.version} > 0`,
    ),
  ],
);

export const workspaceSecurityPolicyChanges = pgTable(
  "workspace_security_policy_changes",
  {
    changedAt: timestamp("changed_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey(),
    minimumPasswordLength: integer("minimum_password_length").notNull(),
    previousMinimumPasswordLength: integer("previous_minimum_password_length")
      .notNull(),
    previousRequireLetterAndNumber: boolean("previous_require_letter_and_number")
      .notNull(),
    previousRequireSpecialCharacter: boolean("previous_require_special_character")
      .notNull(),
    previousResetLinkLifetimeSeconds: integer(
      "previous_reset_link_lifetime_seconds",
    ).notNull(),
    requireLetterAndNumber: boolean("require_letter_and_number").notNull(),
    requireSpecialCharacter: boolean("require_special_character").notNull(),
    resetLinkLifetimeSeconds: integer("reset_link_lifetime_seconds").notNull(),
    revokedResetLinkCount: integer("revoked_reset_link_count").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("workspace_security_policy_changes_workspace_idx").on(
      table.workspaceId,
      table.changedAt,
    ),
    check(
      "workspace_security_policy_changes_values_check",
      sql`${table.minimumPasswordLength} BETWEEN 9 AND 64
        AND ${table.previousMinimumPasswordLength} BETWEEN 9 AND 64
        AND ${table.resetLinkLifetimeSeconds} BETWEEN 900 AND 604800
        AND ${table.previousResetLinkLifetimeSeconds} BETWEEN 900 AND 604800
        AND ${table.revokedResetLinkCount} >= 0`,
    ),
  ],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    activeWorkspaceId: uuid("active_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    tokenDigest: varchar("token_digest", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("user_sessions_user_idx").on(table.userId, table.expiresAt),
    index("user_sessions_expiry_idx").on(table.expiresAt),
    check(
      "user_sessions_token_digest_check",
      sql`${table.tokenDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "user_sessions_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "user_sessions_idle_timeout_check",
      sql`${table.idleTimeoutSeconds} > 0`,
    ),
  ],
);

export const userSetupTokens = pgTable(
  "user_setup_tokens",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    tokenDigest: varchar("token_digest", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("user_setup_tokens_user_idx").on(table.userId),
    index("user_setup_tokens_expiry_idx").on(table.expiresAt),
    index("user_setup_tokens_workspace_expiry_idx").on(
      table.workspaceId,
      table.expiresAt,
    ),
    check(
      "user_setup_tokens_token_digest_check",
      sql`${table.tokenDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "user_setup_tokens_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const applicationSettings = pgTable(
  "application_settings",
  {
    defaults: jsonb("defaults")
      .$type<StoredApplicationSettings>()
      .notNull(),
    id: varchar("id", { length: 32 }).primaryKey(),
    settings: jsonb("settings")
      .$type<StoredApplicationSettings>()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "application_settings_singleton_valid",
      sql`${table.id} = 'runtime' AND ${table.version} > 0`,
    ),
    check(
      "application_settings_documents_valid",
      sql`jsonb_typeof(${table.defaults}) = 'object'
        AND jsonb_typeof(${table.defaults}->'providers') = 'object'
        AND jsonb_typeof(${table.defaults}->'runtime') = 'object'
        AND COALESCE(jsonb_typeof(${table.defaults}->'sourceContent'), '') = 'object'
        AND (
          (
            COALESCE(${table.defaults}#>>'{sourceContent,kind}', 'filesystem') = 'filesystem'
            AND COALESCE(jsonb_typeof(${table.defaults}#>'{sourceContent,directory}'), '') = 'string'
            AND COALESCE(${table.defaults}#>>'{sourceContent,directory}', '') <> ''
          )
          OR (
            ${table.defaults}#>>'{sourceContent,kind}' = 's3'
            AND COALESCE(${table.defaults}#>>'{sourceContent,bucket}', '') <> ''
            AND COALESCE(${table.defaults}#>>'{sourceContent,endpointUrl}', '') <> ''
            AND COALESCE(jsonb_typeof(${table.defaults}#>'{sourceContent,forcePathStyle}'), '') = 'boolean'
            AND COALESCE(${table.defaults}#>>'{sourceContent,prefix}', '') <> ''
            AND COALESCE(${table.defaults}#>>'{sourceContent,region}', '') <> ''
          )
        )
        AND ${table.defaults}->>'schemaVersion' = '1'
        AND jsonb_typeof(${table.settings}) = 'object'
        AND jsonb_typeof(${table.settings}->'providers') = 'object'
        AND jsonb_typeof(${table.settings}->'runtime') = 'object'
        AND COALESCE(jsonb_typeof(${table.settings}->'sourceContent'), '') = 'object'
        AND (
          (
            COALESCE(${table.settings}#>>'{sourceContent,kind}', 'filesystem') = 'filesystem'
            AND COALESCE(jsonb_typeof(${table.settings}#>'{sourceContent,directory}'), '') = 'string'
            AND COALESCE(${table.settings}#>>'{sourceContent,directory}', '') <> ''
          )
          OR (
            ${table.settings}#>>'{sourceContent,kind}' = 's3'
            AND COALESCE(${table.settings}#>>'{sourceContent,bucket}', '') <> ''
            AND COALESCE(${table.settings}#>>'{sourceContent,endpointUrl}', '') <> ''
            AND COALESCE(jsonb_typeof(${table.settings}#>'{sourceContent,forcePathStyle}'), '') = 'boolean'
            AND COALESCE(${table.settings}#>>'{sourceContent,prefix}', '') <> ''
            AND COALESCE(${table.settings}#>>'{sourceContent,region}', '') <> ''
          )
        )
        AND ${table.settings}->>'schemaVersion' = '1'`,
    ),
  ],
);

export const sourceContentMigrations = pgTable(
  "source_content_migrations",
  {
    activeSlot: integer("active_slot"),
    attemptCount: integer("attempt_count").notNull().default(0),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    copiedDocuments: integer("copied_documents").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    errorMessage: text("error_message"),
    id: uuid("id").primaryKey(),
    lastDocumentId: varchar("last_document_id", { length: 64 }),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    leaseOwner: uuid("lease_owner"),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    sourceConfig: jsonb("source_config")
      .$type<SourceContentConfig>()
      .notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    state: varchar("state", { length: 32 })
      .$type<
        | "queued"
        | "validating"
        | "copying"
        | "cutover"
        | "cancel_requested"
        | "completed"
        | "failed"
        | "cancelled"
      >()
      .notNull(),
    targetConfig: jsonb("target_config")
      .$type<SourceContentConfig>()
      .notNull(),
    totalDocuments: integer("total_documents").notNull().default(0),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    verifiedDocuments: integer("verified_documents").notNull().default(0),
  },
  (table) => [
    uniqueIndex("source_content_migrations_active_slot_idx")
      .on(table.activeSlot)
      .where(sql`${table.activeSlot} IS NOT NULL`),
    index("source_content_migrations_state_lease_idx")
      .on(table.state, table.leaseExpiresAt),
    check(
      "source_content_migrations_values_valid",
      sql`${table.attemptCount} >= 0
        AND ${table.copiedDocuments} >= 0
        AND ${table.totalDocuments} >= 0
        AND ${table.verifiedDocuments} >= 0
        AND (${table.lastDocumentId} IS NULL OR ${table.lastDocumentId} ~ '^[a-f0-9]{64}$')
        AND jsonb_typeof(${table.sourceConfig}) = 'object'
        AND jsonb_typeof(${table.targetConfig}) = 'object'
        AND ${table.state} IN (
          'queued',
          'validating',
          'copying',
          'cutover',
          'cancel_requested',
          'completed',
          'failed',
          'cancelled'
        )
        AND (
          (
            ${table.state} IN (
              'queued',
              'validating',
              'copying',
              'cutover',
              'cancel_requested'
            )
            AND ${table.activeSlot} = 1
          )
          OR (
            ${table.state} IN ('completed', 'failed', 'cancelled')
            AND ${table.activeSlot} IS NULL
          )
        )
        AND (
          (${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)
          OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
        )
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
        AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const providerOAuthCredentials = pgTable(
  "provider_oauth_credentials",
  {
    accessToken: text("access_token").notNull(),
    accountId: text("account_id").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    providerId: varchar("provider_id", { length: 64 }).primaryKey(),
    refreshToken: text("refresh_token").notNull(),
    status: varchar("status", { length: 32 })
      .$type<"connected" | "reauth-required">()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "provider_oauth_credentials_provider_valid",
      sql`${table.providerId} = 'openai-codex'`,
    ),
    check(
      "provider_oauth_credentials_values_valid",
      sql`length(trim(${table.accessToken})) > 0
        AND length(trim(${table.refreshToken})) > 0
        AND length(trim(${table.accountId})) > 0
        AND ${table.status} IN ('connected', 'reauth-required')
        AND ${table.version} > 0`,
    ),
  ],
);

export const applicationRevisions = pgTable(
  "application_revisions",
  {
    channel: varchar("channel", { length: 16 }).primaryKey(),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(sql`0`),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "application_revisions_values_valid",
      sql`${table.channel} IN ('catalog', 'jobs', 'settings')
        AND ${table.revision} >= 0`,
    ),
  ],
);

export const embeddingInputFormats = pgTable(
  "embedding_input_formats",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    documentTemplate: text("document_template").notNull(),
    id: uuid("id").primaryKey(),
    inputFormatHash: varchar("input_format_hash", { length: 64 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    queryTemplate: text("query_template").notNull(),
    retiredAt: timestamp("retired_at", { mode: "date", withTimezone: true }),
    schemaVersion: integer("schema_version").notNull(),
  },
  (table) => [
    check(
      "embedding_input_formats_values_valid",
      sql`length(trim(${table.name})) > 0
        AND ${table.schemaVersion} > 0
        AND length(${table.documentTemplate})
          - length(replace(${table.documentTemplate}, '{{text}}', '')) = 8
        AND length(${table.queryTemplate})
          - length(replace(${table.queryTemplate}, '{{text}}', '')) = 8
        AND ${table.inputFormatHash} ~ '^[a-f0-9]{64}$'
        AND (${table.retiredAt} IS NULL OR ${table.retiredAt} >= ${table.createdAt})`,
    ),
    index("embedding_input_formats_retired_name_idx").on(
      table.retiredAt,
      table.name,
    ),
  ],
);

export const embeddingSpaces = pgTable(
  "embedding_spaces",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    dimensions: integer("dimensions").notNull(),
    id: text("id").primaryKey(),
    inputFormatDocumentTemplate: text("input_format_document_template").notNull(),
    inputFormatHash: varchar("input_format_hash", { length: 64 }).notNull(),
    inputFormatId: uuid("input_format_id")
      .notNull()
      .references(() => embeddingInputFormats.id, { onDelete: "restrict" }),
    inputFormatQueryTemplate: text("input_format_query_template").notNull(),
    inputFormatSchemaVersion: integer("input_format_schema_version").notNull(),
    model: text("model").notNull(),
    inputFormatName: text("profile").notNull(),
    retrievalWindowPolicy: jsonb("retrieval_window_policy")
      .$type<StoredRetrievalWindowPolicy>()
      .notNull(),
    retrievalWindowPolicyFingerprint: varchar(
      "retrieval_window_policy_fingerprint",
      { length: 64 },
    ).notNull(),
  },
  (table) => [
    check(
      "embedding_spaces_retrieval_window_policy_fingerprint_valid",
      sql`${table.retrievalWindowPolicyFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "embedding_spaces_input_format_snapshot_valid",
      sql`${table.inputFormatHash} ~ '^[a-f0-9]{64}$'
        AND ${table.inputFormatSchemaVersion} > 0`,
    ),
  ],
);

export const embeddingSpacePins = pgTable("embedding_space_pins", {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  reason: text("reason").notNull(),
  spaceId: text("space_id")
    .primaryKey()
    .references(() => embeddingSpaces.id, { onDelete: "cascade" }),
});

export const embeddingSpaceGcRuns = pgTable("embedding_space_gc_runs", {
  activeSpaceId: text("active_space_id").notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  errorMessage: text("error_message"),
  id: uuid("id").primaryKey(),
  mode: varchar("mode", { length: 16 }).notNull(),
  retentionCutoff: timestamp("retention_cutoff", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  status: varchar("status", { length: 16 }).notNull(),
});

export const embeddingSpaceGcSpaces = pgTable(
  "embedding_space_gc_spaces",
  {
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull(),
    dimensions: integer("dimensions").notNull(),
    disposition: varchar("disposition", { length: 16 }).notNull(),
    errorMessage: text("error_message"),
    estimatedBytes: bigint("estimated_bytes", { mode: "bigint" }).notNull(),
    inputFormatHash: varchar("input_format_hash", { length: 64 }).notNull(),
    inputFormatName: varchar("input_format_name", { length: 100 }).notNull(),
    model: text("model").notNull(),
    legacyProfile: text("profile").notNull(),
    protectionDetail: text("protection_detail"),
    protectionKind: varchar("protection_kind", { length: 32 }),
    rowCounts: jsonb("row_counts").$type<EmbeddingSpaceRowCounts>().notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => embeddingSpaceGcRuns.id, { onDelete: "cascade" }),
    spaceId: text("space_id").notNull(),
    state: varchar("state", { length: 16 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.spaceId] })],
);

export const documentElementSets = pgTable(
  "document_element_sets",
  {
    complete: boolean("complete").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    documentId: varchar("document_id", { length: 64 }).notNull(),
    elementCount: integer("element_count").notNull(),
    id: varchar("id", { length: 64 }).primaryKey(),
  },
  (table) => [
    check(
      "document_element_sets_element_count_check",
      sql`${table.elementCount} > 0`,
    ),
    index("document_element_sets_document_idx").on(table.documentId),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    documentId: varchar("document_id", { length: 64 })
      .notNull()
      .references(() => sourceDocuments.documentId, { onDelete: "restrict" }),
    elementSetId: varchar("element_set_id", { length: 64 })
      .notNull()
      .references(() => documentElementSets.id, { onDelete: "restrict" }),
    fileExtension: varchar("file_extension", { length: 33 }).notNull(),
    generationId: uuid("generation_id").notNull(),
    id: uuid("id").primaryKey(),
    images: integer("images").notNull(),
    mediaType: text("media_type").notNull(),
    pageCount: integer("page_count"),
    sourceFile: text("source_file").notNull(),
    tables: integer("tables").notNull(),
    textChunks: integer("text_chunks").notNull(),
    totalElements: integer("total_elements").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    unique("document_versions_identity_set_unique").on(
      table.id,
      table.elementSetId,
    ),
    uniqueIndex("document_versions_source_version_idx").on(
      table.sourceFile,
      table.version,
    ),
    index("document_versions_document_idx").on(table.documentId),
  ],
);

export const indexedDocuments = pgTable(
  "indexed_documents",
  {
    documentId: varchar("document_id", { length: 64 })
      .notNull()
      .references(() => sourceDocuments.documentId, { onDelete: "restrict" }),
    elementSetId: varchar("element_set_id", { length: 64 })
      .notNull()
      .references(() => documentElementSets.id, { onDelete: "restrict" }),
    generationId: uuid("generation_id").notNull(),
    images: integer("images").notNull().default(0),
    indexedAt: timestamp("indexed_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    pageCount: integer("page_count"),
    sourceFile: text("source_file").primaryKey(),
    tables: integer("tables").notNull().default(0),
    tags: text("tags").array().notNull().default([]),
    textChunks: integer("text_chunks").notNull().default(0),
    totalElements: integer("total_elements").notNull().default(0),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
  },
  (table) => [
    check(
      "indexed_documents_page_count_check",
      sql`${table.pageCount} IS NULL OR ${table.pageCount} > 0`,
    ),
    index("indexed_documents_document_id_idx").on(table.documentId),
    index("indexed_documents_tags_gin_idx").using("gin", table.tags),
  ],
);

export const indexedDocumentSpaces = pgTable(
  "indexed_document_spaces",
  {
    documentId: varchar("document_id", { length: 64 }).notNull(),
    embeddingSpaceId: text("embedding_space_id")
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: "cascade" }),
    indexedAt: timestamp("indexed_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    generationId: uuid("generation_id").notNull(),
    representationCount: integer("representation_count").notNull(),
    sourceFile: text("source_file").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceFile, table.embeddingSpaceId] }),
    check(
      "indexed_document_spaces_representation_count_check",
      sql`${table.representationCount} > 0`,
    ),
    unique("indexed_document_spaces_projection_identity_unique").on(
      table.sourceFile,
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("indexed_document_spaces_document_id_idx").on(table.documentId),
    index("indexed_document_spaces_space_idx").on(table.embeddingSpaceId),
  ],
);

export const doclingServiceInstances = pgTable(
  "docling_service_instances",
  {
    baseUrl: text("base_url").notNull(),
    capabilitiesFingerprint: varchar("capabilities_fingerprint", {
      length: 64,
    }),
    capacity: integer("capacity").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    errorCategory: varchar("error_category", { length: 64 }),
    id: varchar("id", { length: 100 }).primaryKey(),
    lastVerifiedAt: timestamp("last_verified_at", {
      mode: "date",
      withTimezone: true,
    }),
    processConfig: jsonb("process_config")
      .$type<DoclingProcessConfiguration>()
      .notNull(),
    serviceIdentity: jsonb("service_identity").$type<DoclingServiceIdentity>(),
    state: doclingServiceState("state").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    verificationConfigFingerprint: varchar(
      "verification_config_fingerprint",
      { length: 64 },
    ),
  },
  (table) => [
    check(
      "docling_service_instances_id_check",
      sql`length(trim(${table.id})) > 0`,
    ),
    check(
      "docling_service_instances_base_url_check",
      sql`length(trim(${table.baseUrl})) > 0`,
    ),
    check(
      "docling_service_instances_capacity_check",
      sql`${table.capacity} > 0`,
    ),
    check(
      "docling_service_instances_active_check",
      sql`${table.state} <> 'active' OR (${table.capabilitiesFingerprint} IS NOT NULL AND ${table.serviceIdentity} IS NOT NULL AND ${table.lastVerifiedAt} IS NOT NULL AND ${table.verificationConfigFingerprint} IS NOT NULL AND ${table.errorCategory} IS NULL)`,
    ),
    check(
      "docling_service_instances_capabilities_fingerprint_check",
      sql`${table.capabilitiesFingerprint} IS NULL OR ${table.capabilitiesFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "docling_service_instances_verification_config_fingerprint_check",
      sql`${table.verificationConfigFingerprint} IS NULL OR ${table.verificationConfigFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    uniqueIndex("docling_service_instances_base_url_idx").on(table.baseUrl),
  ],
);

export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    attemptCount: integer("attempt_count").notNull().default(0),
    documentId: varchar("document_id", { length: 64 })
      .notNull()
      .references(() => sourceDocuments.documentId, { onDelete: "restrict" }),
    doclingAttemptConfig: jsonb("docling_attempt_config")
      .$type<DoclingAttemptConfigSnapshot>(),
    doclingRunId: uuid("docling_run_id").references(
      () => doclingConversionRuns.id,
      { onDelete: "set null" },
    ),
    doclingServiceInstanceId: varchar("docling_service_instance_id", {
      length: 100,
    }).references(() => doclingServiceInstances.id, { onDelete: "restrict" }),
    doclingServiceSlot: integer("docling_service_slot"),
    elementSetId: varchar("element_set_id", { length: 64 }).references(
      () => documentElementSets.id,
      { onDelete: "restrict" },
    ),
    embeddingSpaceId: text("embedding_space_id").notNull(),
    errorMessage: text("error_message"),
    fileExtension: varchar("file_extension", { length: 33 }).notNull(),
    generationId: uuid("generation_id")
      .notNull()
      .unique("ingestion_jobs_generation_idx"),
    images: integer("images").notNull().default(0),
    indexingActivity: ingestionIndexingActivity("indexing_activity"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    maxAttempts: integer("max_attempts").notNull().default(3),
    mediaType: text("media_type").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", {
      mode: "date",
      withTimezone: true,
    }).notNull().defaultNow(),
    ownerId: uuid("owner_id"),
    pageCount: integer("page_count"),
    phase: ingestionPhase("phase").notNull().default("discovered"),
    controlError: text("control_error"),
    controlState: ingestionControlState("control_state").notNull().default("active"),
    sourceFile: text("source_file").primaryKey(),
    state: ingestionState("state").notNull().default("pending"),
    tables: integer("tables").notNull().default(0),
    tags: text("tags").array().notNull().default([]),
    textChunks: integer("text_chunks").notNull().default(0),
    totalElements: integer("total_elements").notNull().default(0),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    check(
      "ingestion_jobs_docling_run_config_check",
      sql`${table.doclingRunId} IS NULL OR ${table.doclingAttemptConfig} IS NOT NULL`,
    ),
    check(
      "ingestion_jobs_docling_assignment_fields_check",
      sql`(${table.doclingServiceInstanceId} IS NULL AND ${table.doclingServiceSlot} IS NULL) OR (${table.doclingServiceInstanceId} IS NOT NULL AND ${table.doclingServiceSlot} IS NOT NULL)`,
    ),
    check(
      "ingestion_jobs_docling_assignment_phase_check",
      sql`${table.doclingServiceInstanceId} IS NULL OR ${table.phase} = 'discovered'`,
    ),
    check(
      "ingestion_jobs_docling_assignment_slot_check",
      sql`${table.doclingServiceSlot} IS NULL OR ${table.doclingServiceSlot} > 0`,
    ),
    check(
      "ingestion_jobs_page_count_check",
      sql`${table.pageCount} IS NULL OR ${table.pageCount} > 0`,
    ),
    check(
      "ingestion_jobs_indexing_activity_phase_check",
      sql`(${table.phase} = 'normalized' AND ${table.indexingActivity} IS NOT NULL) OR (${table.phase} <> 'normalized' AND ${table.indexingActivity} IS NULL)`,
    ),
    index("ingestion_jobs_document_id_idx").on(table.documentId),
    index("ingestion_jobs_control_state_idx").on(table.controlState, table.state),
    index("ingestion_jobs_due_idx").on(
      table.state,
      table.nextAttemptAt,
      table.updatedAt,
    ),
    uniqueIndex("ingestion_jobs_docling_service_slot_idx")
      .on(table.doclingServiceInstanceId, table.doclingServiceSlot)
      .where(sql`${table.doclingServiceInstanceId} IS NOT NULL`),
  ],
);

export const applicationErrorEvents = pgTable(
  "application_error_events",
  {
    attemptNumber: integer("attempt_number"),
    category: varchar("category", { length: 64 }).notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    documentId: varchar("document_id", { length: 64 }),
    id: uuid("id").primaryKey(),
    instance: text("instance"),
    jobId: text("job_id"),
    message: text("message").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull(),
    operation: varchar("operation", { length: 128 }).notNull(),
    origin: applicationErrorOrigin("origin").notNull(),
    release: text("release"),
    requestId: text("request_id"),
    requestSequence: integer("request_sequence"),
    retryable: boolean("retryable"),
    runId: text("run_id"),
    service: varchar("service", { length: 64 }).notNull(),
    severity: applicationErrorSeverity("severity").notNull(),
    sourceFile: text("source_file"),
    stackFingerprint: varchar("stack_fingerprint", { length: 64 }),
    taskId: text("task_id"),
    workspaceId: text("workspace_id"),
  },
  (table) => [
    index("application_error_events_occurred_at_idx").on(table.occurredAt),
    index("application_error_events_workspace_occurred_idx").on(
      table.workspaceId,
      table.occurredAt,
      table.id,
    ),
    index("application_error_events_workspace_origin_occurred_idx").on(
      table.workspaceId,
      table.origin,
      table.occurredAt,
      table.id,
    ),
    index("application_error_events_service_operation_idx").on(
      table.service,
      table.operation,
      table.occurredAt,
    ),
    index("application_error_events_job_idx").on(
      table.jobId,
      table.occurredAt,
    ),
    index("application_error_events_document_idx").on(
      table.documentId,
      table.occurredAt,
    ),
    check(
      "application_error_events_attempt_check",
      sql`${table.attemptNumber} IS NULL OR ${table.attemptNumber} > 0`,
    ),
    check(
      "application_error_events_request_sequence_check",
      sql`${table.requestSequence} IS NULL OR ${table.requestSequence} >= 0`,
    ),
    check(
      "application_error_events_category_check",
      sql`length(trim(${table.category})) > 0`,
    ),
    check(
      "application_error_events_code_check",
      sql`length(trim(${table.code})) > 0`,
    ),
    check(
      "application_error_events_message_check",
      sql`length(trim(${table.message})) > 0`,
    ),
    check(
      "application_error_events_operation_check",
      sql`length(trim(${table.operation})) > 0`,
    ),
    check(
      "application_error_events_service_check",
      sql`length(trim(${table.service})) > 0`,
    ),
    check(
      "application_error_events_stack_fingerprint_check",
      sql`${table.stackFingerprint} IS NULL OR ${table.stackFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const doclingErrorDetails = pgTable(
  "docling_error_details",
  {
    applicationErrorId: uuid("application_error_id")
      .notNull()
      .references(() => applicationErrorEvents.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 64 }).notNull(),
    componentType: varchar("component_type", { length: 64 }).notNull(),
    doclingLabel: text("docling_label"),
    elementKind: elementKind("element_kind"),
    message: text("message").notNull(),
    moduleName: text("module_name").notNull(),
    pageNumber: integer("page_number"),
    pageRangeEnd: integer("page_range_end"),
    pageRangeStart: integer("page_range_start"),
    sequence: integer("sequence").notNull(),
    sourceRef: text("source_ref"),
  },
  (table) => [
    primaryKey({
      columns: [table.applicationErrorId, table.sequence],
    }),
    check(
      "docling_error_details_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "docling_error_details_page_check",
      sql`${table.pageNumber} IS NULL OR ${table.pageNumber} > 0`,
    ),
    check(
      "docling_error_details_range_check",
      sql`(${table.pageRangeStart} IS NULL AND ${table.pageRangeEnd} IS NULL)
        OR (${table.pageRangeStart} > 0 AND ${table.pageRangeEnd} >= ${table.pageRangeStart})`,
    ),
    check(
      "docling_error_details_category_check",
      sql`length(trim(${table.category})) > 0`,
    ),
    check(
      "docling_error_details_component_check",
      sql`length(trim(${table.componentType})) > 0`,
    ),
    check(
      "docling_error_details_message_check",
      sql`length(trim(${table.message})) > 0`,
    ),
  ],
);

export const sourceDocuments = pgTable("source_documents", {
  byteLength: bigint("byte_length", { mode: "number" }).notNull(),
  lastPublishedAt: timestamp("last_published_at", {
    mode: "date",
    withTimezone: true,
  })
    .notNull()
    .defaultNow(),
  documentId: varchar("document_id", { length: 64 }).primaryKey(),
});

export const sourceContentDeletions = pgTable(
  "source_content_deletions",
  {
    attemptCount: integer("attempt_count").notNull().default(0),
    documentId: varchar("document_id", { length: 64 }).primaryKey(),
    lastAttemptAt: timestamp("last_attempt_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("source_content_deletions_requested_at_idx").on(table.requestedAt),
  ],
);

export const sourceElements = pgTable(
  "source_elements",
  {
    documentId: varchar("document_id", { length: 64 }).notNull(),
    element: jsonb("element").$type<RetrievalSourceElement>().notNull(),
    id: varchar("id", { length: 64 }).primaryKey(),
    imageContent: customType<{ data: Buffer }>({
      dataType: () => "bytea",
    })("image_content"),
  },
  (table) => [
    index("source_elements_document_id_idx").on(table.documentId),
    check(
      "source_elements_image_content_check",
      sql`
        CASE
          WHEN ${table.element}->>'kind' = 'image'
            THEN ${table.imageContent} IS NOT NULL
              AND NOT (${table.element} ? 'content')
          WHEN ${table.element}->>'kind' IN ('table', 'text')
            THEN ${table.imageContent} IS NULL
              AND ${table.element} ? 'content'
          ELSE FALSE
        END
      `,
    ),
  ],
);

export const documentElementSetMembers = pgTable(
  "document_element_set_members",
  {
    elementId: varchar("element_id", { length: 64 })
      .notNull()
      .references(() => sourceElements.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    setId: varchar("set_id", { length: 64 })
      .notNull()
      .references(() => documentElementSets.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.setId, table.position] }),
    unique("document_element_set_members_identity_unique").on(
      table.setId,
      table.elementId,
    ),
    check(
      "document_element_set_members_position_check",
      sql`${table.position} >= 0`,
    ),
  ],
);

export const ingestionEmbeddingManifests = pgTable(
  "ingestion_embedding_manifests",
  {
    completed: boolean("completed").notNull().default(false),
    documentId: varchar("document_id", { length: 64 }).notNull(),
    elementSetId: varchar("element_set_id", { length: 64 })
      .notNull()
      .references(() => documentElementSets.id, { onDelete: "restrict" }),
    embeddingSpaceId: text("embedding_space_id")
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: "cascade" }),
    exactRepresentationCount: integer("exact_representation_count")
      .notNull()
      .default(0),
    generationId: uuid("generation_id")
      .primaryKey()
      .references(() => ingestionJobs.generationId, { onDelete: "cascade" }),
    nextElementPosition: integer("next_element_position")
      .notNull()
      .default(0),
    retrievalPolicyFingerprint: varchar(
      "retrieval_policy_fingerprint",
      { length: 64 },
    ).notNull(),
    descriptionRepresentationCount: integer("description_representation_count")
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ingestion_embedding_manifests_counts_check",
      sql`${table.nextElementPosition} >= 0 AND ${table.exactRepresentationCount} >= 0 AND ${table.descriptionRepresentationCount} >= 0`,
    ),
  ],
);

export const researchThreads = pgTable("research_threads", {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chatConversations = pgTable(
  "chat_conversations",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    scope: jsonb("scope").$type<QueryScope>().notNull(),
    title: text("title").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.ownerUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
      name: "chat_conversations_owner_membership_fk",
    }).onDelete("cascade"),
    check(
      "chat_conversations_title_check",
      sql`length(trim(${table.title})) > 0`,
    ),
    index("chat_conversations_owner_updated_idx").on(
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
    ),
  ],
);

export const chatRuns = pgTable(
  "chat_runs",
  {
    attemptCount: integer("attempt_count").notNull().default(1),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    errorMessage: text("error_message"),
    id: uuid("id").primaryKey(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    memoryTrace: jsonb("memory_trace").$type<ChatMemoryTrace>(),
    retrievalTrace: jsonb("retrieval_trace").$type<ResearchRetrievalTrace>(),
    runConfiguration: jsonb("run_configuration").$type<ChatRunConfiguration>(),
    sequence: integer("sequence").notNull(),
    state: chatRunState("state").notNull().default("accepted"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "chat_runs_values_check",
      sql`${table.attemptCount} > 0 AND ${table.sequence} > 0`,
    ),
    check(
      "chat_runs_completion_check",
      sql`(
          ${table.state} IN ('completed', 'failed', 'canceled')
          AND ${table.completedAt} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NULL
        ) OR (
          ${table.state} NOT IN ('completed', 'failed', 'canceled')
          AND ${table.completedAt} IS NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
        )`,
    ),
    check(
      "chat_runs_error_check",
      sql`(${table.state} = 'failed' AND ${table.errorMessage} IS NOT NULL)
        OR (${table.state} <> 'failed' AND ${table.errorMessage} IS NULL)`,
    ),
    check(
      "chat_runs_publication_check",
      sql`(
          ${table.state} = 'completed'
          AND ${table.memoryTrace} IS NOT NULL
          AND ${table.retrievalTrace} IS NOT NULL
          AND ${table.runConfiguration} IS NOT NULL
        ) OR (
          ${table.state} <> 'completed'
          AND ${table.memoryTrace} IS NULL
          AND ${table.retrievalTrace} IS NULL
          AND ${table.runConfiguration} IS NULL
        )`,
    ),
    uniqueIndex("chat_runs_conversation_sequence_idx").on(
      table.conversationId,
      table.sequence,
    ),
    index("chat_runs_conversation_state_idx").on(
      table.conversationId,
      table.state,
    ),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    answerDocument: jsonb("answer_document").$type<PublishedAnswerDocument>(),
    claims: jsonb("claims").$type<ChatClaimVerificationResult[]>(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    id: uuid("id").primaryKey(),
    role: chatMessageRole("role").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => chatRuns.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "chat_messages_content_check",
      sql`length(trim(${table.content})) > 0`,
    ),
    check(
      "chat_messages_output_check",
      sql`(
          ${table.role} = 'user'
          AND ${table.answerDocument} IS NULL
          AND ${table.claims} IS NULL
        ) OR (
          ${table.role} = 'assistant'
          AND ${table.answerDocument} IS NOT NULL
          AND ${table.claims} IS NOT NULL
        )`,
    ),
    uniqueIndex("chat_messages_run_role_idx").on(table.runId, table.role),
    index("chat_messages_run_created_idx").on(table.runId, table.createdAt),
  ],
);

export const chatEvidenceDocuments = pgTable(
  "chat_evidence_documents",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    documentId: varchar("document_id", { length: 64 })
      .notNull()
      .references(() => sourceDocuments.documentId, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id").primaryKey(),
    fileExtension: varchar("file_extension", { length: 33 }).notNull(),
    mediaType: text("media_type").notNull(),
    sourceFile: text("source_file").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    check(
      "chat_evidence_documents_values_check",
      sql`length(trim(${table.sourceFile})) > 0 AND ${table.version} > 0`,
    ),
    index("chat_evidence_documents_document_idx").on(table.documentId),
  ],
);

export const chatCitationRecords = pgTable(
  "chat_citation_records",
  {
    assistantMessageId: uuid("assistant_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    citationNumber: integer("citation_number").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => chatEvidenceDocuments.documentVersionId, {
        onDelete: "restrict",
      }),
    elementId: varchar("element_id", { length: 64 }).notNull(),
    evidence: jsonb("evidence").$type<CitationEvidence>().notNull(),
    id: uuid("id").primaryKey(),
    imageContent: customType<{ data: Buffer }>({
      dataType: () => "bytea",
    })("image_content"),
    pageNumbers: integer("page_numbers").array().notNull(),
    regions: jsonb("regions").$type<SourceRegion[]>().notNull(),
    sectionPath: text("section_path").array().notNull(),
    sourceFile: text("source_file").notNull(),
  },
  (table) => [
    check(
      "chat_citation_records_values_check",
      sql`${table.citationNumber} > 0
        AND length(trim(${table.sourceFile})) > 0
        AND (
          (${table.evidence}->>'kind' = 'image' AND ${table.imageContent} IS NOT NULL)
          OR (
            ${table.evidence}->>'kind' IN ('table', 'text')
            AND ${table.imageContent} IS NULL
          )
        )`,
    ),
    unique("chat_citation_records_message_identity_unique").on(
      table.assistantMessageId,
      table.id,
    ),
    uniqueIndex("chat_citation_records_message_number_idx").on(
      table.assistantMessageId,
      table.citationNumber,
    ),
    index("chat_citation_records_version_idx").on(table.documentVersionId),
  ],
);

export const chatVerificationJobs = pgTable(
  "chat_verification_jobs",
  {
    assistantMessageId: uuid("assistant_message_id")
      .primaryKey()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    errorMessage: text("error_message"),
    failureCount: integer("failure_count").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    state: chatVerificationJobState("state").notNull().default("pending"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "chat_verification_jobs_counts_check",
      sql`${table.attemptCount} >= 0 AND ${table.failureCount} >= 0`,
    ),
    check(
      "chat_verification_jobs_state_check",
      sql`(
          ${table.state} = 'pending'
          AND ${table.completedAt} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
        ) OR (
          ${table.state} = 'running'
          AND ${table.completedAt} IS NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
        ) OR (
          ${table.state} IN ('completed', 'failed')
          AND ${table.completedAt} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NULL
        )`,
    ),
    check(
      "chat_verification_jobs_error_check",
      sql`(${table.state} = 'failed' AND ${table.errorMessage} IS NOT NULL)
        OR ${table.state} <> 'failed'`,
    ),
    index("chat_verification_jobs_dispatch_idx").on(
      table.state,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

function createChatMessageEmbeddingColumns() {
  return {
    content: text("content").notNull(),
    embeddingSpaceId: text("embedding_space_id")
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: "cascade" }),
    inputTokens: integer("input_tokens").notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    partOrdinal: integer("part_ordinal").notNull(),
  };
}

export const chatMessageEmbeddings384 = pgTable(
  "chat_message_embeddings_384",
  {
    ...createChatMessageEmbeddingColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_384,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.messageId,
        table.partOrdinal,
      ],
    }),
    check(
      "chat_message_embeddings_384_values_check",
      sql`${table.inputTokens} > 0 AND ${table.partOrdinal} >= 0`,
    ),
    index("chat_message_embeddings_384_message_idx").on(table.messageId),
    index("chat_message_embeddings_384_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const chatMessageEmbeddings768 = pgTable(
  "chat_message_embeddings_768",
  {
    ...createChatMessageEmbeddingColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_768,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.messageId,
        table.partOrdinal,
      ],
    }),
    check(
      "chat_message_embeddings_768_values_check",
      sql`${table.inputTokens} > 0 AND ${table.partOrdinal} >= 0`,
    ),
    index("chat_message_embeddings_768_message_idx").on(table.messageId),
    index("chat_message_embeddings_768_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const chatMessageEmbeddings1024 = pgTable(
  "chat_message_embeddings_1024",
  {
    ...createChatMessageEmbeddingColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_1024,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.messageId,
        table.partOrdinal,
      ],
    }),
    check(
      "chat_message_embeddings_1024_values_check",
      sql`${table.inputTokens} > 0 AND ${table.partOrdinal} >= 0`,
    ),
    index("chat_message_embeddings_1024_message_idx").on(table.messageId),
    index("chat_message_embeddings_1024_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const chatMessageEmbeddings1536 = pgTable(
  "chat_message_embeddings_1536",
  {
    ...createChatMessageEmbeddingColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_1536,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.messageId,
        table.partOrdinal,
      ],
    }),
    check(
      "chat_message_embeddings_1536_values_check",
      sql`${table.inputTokens} > 0 AND ${table.partOrdinal} >= 0`,
    ),
    index("chat_message_embeddings_1536_message_idx").on(table.messageId),
    index("chat_message_embeddings_1536_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const chatMessageEmbeddings2048 = pgTable(
  "chat_message_embeddings_2048",
  {
    ...createChatMessageEmbeddingColumns(),
    embedding: halfvec("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_2048,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.messageId,
        table.partOrdinal,
      ],
    }),
    check(
      "chat_message_embeddings_2048_values_check",
      sql`${table.inputTokens} > 0 AND ${table.partOrdinal} >= 0`,
    ),
    index("chat_message_embeddings_2048_message_idx").on(table.messageId),
    index("chat_message_embeddings_2048_hnsw_idx")
      .using("hnsw", table.embedding.op("halfvec_cosine_ops")),
  ],
);

export const researchTurns = pgTable(
  "research_turns",
  {
    answerSchemaVersion: integer("answer_schema_version").notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true })
      .notNull(),
    id: uuid("id").primaryKey(),
    answerContent: text("answer_content"),
    question: text("question").notNull(),
    outputState: researchOutputState("output_state").notNull(),
    retrievedContext: jsonb("retrieved_context").$type<MatchedDocument[]>().notNull(),
    retrievalTrace: jsonb("retrieval_trace")
      .$type<StoredResearchRetrievalTrace>()
      .notNull(),
    runConfiguration: jsonb("run_configuration")
      .$type<ResearchRunConfiguration>()
      .notNull(),
    runId: uuid("run_id").notNull(),
    scope: jsonb("scope").$type<QueryScope>().notNull(),
    sequence: integer("sequence").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => researchThreads.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "research_turns_answer_schema_version_check",
      sql`${table.answerSchemaVersion} = 2`,
    ),
    check(
      "research_turns_answer_content_check",
      sql`${table.answerContent} IS NULL OR length(trim(${table.answerContent})) > 0`,
    ),
    uniqueIndex("research_turns_thread_sequence_idx").on(
      table.threadId,
      table.sequence,
    ),
    uniqueIndex("research_turns_run_idx").on(table.runId),
  ],
);

export const researchVerificationJobs = pgTable(
  "research_verification_jobs",
  {
    turnId: uuid("turn_id")
      .primaryKey()
      .references(() => researchTurns.id, { onDelete: "cascade" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    errorMessage: text("error_message"),
    failureCount: integer("failure_count").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    state: researchVerificationJobState("state").notNull().default("pending"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "research_verification_jobs_counts_check",
      sql`${table.attemptCount} >= 0 AND ${table.failureCount} >= 0`,
    ),
    check(
      "research_verification_jobs_state_check",
      sql`(
          ${table.state} = 'pending'
          AND ${table.completedAt} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
        ) OR (
          ${table.state} = 'running'
          AND ${table.completedAt} IS NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
        ) OR (
          ${table.state} IN ('completed', 'failed')
          AND ${table.completedAt} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NULL
        )`,
    ),
    check(
      "research_verification_jobs_error_check",
      sql`(${table.state} = 'failed' AND ${table.errorMessage} IS NOT NULL)
        OR ${table.state} <> 'failed'`,
    ),
    index("research_verification_jobs_dispatch_idx").on(
      table.state,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const citationRecords = pgTable(
  "citation_records",
  {
    citationNumber: integer("citation_number").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    documentVersionId: uuid("document_version_id").notNull(),
    elementSetId: varchar("element_set_id", { length: 64 }).notNull(),
    elementId: varchar("element_id", { length: 64 }).notNull(),
    evidence: jsonb("evidence").$type<CitationEvidence>().notNull(),
    id: uuid("id").primaryKey(),
    pageNumbers: integer("page_numbers").array().notNull(),
    regions: jsonb("regions").$type<SourceRegion[]>().notNull(),
    sectionPath: text("section_path").array().notNull(),
    sourceFile: text("source_file").notNull(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => researchTurns.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "citation_records_values_valid",
      sql`${table.citationNumber} > 0 AND length(trim(${table.sourceFile})) > 0`,
    ),
    foreignKey({
      columns: [table.documentVersionId, table.elementSetId],
      foreignColumns: [documentVersions.id, documentVersions.elementSetId],
      name: "citation_records_version_element_set_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.elementSetId, table.elementId],
      foreignColumns: [
        documentElementSetMembers.setId,
        documentElementSetMembers.elementId,
      ],
      name: "citation_records_element_set_member_fk",
    }).onDelete("restrict"),
    unique("citation_records_turn_identity_unique").on(
      table.turnId,
      table.id,
    ),
    uniqueIndex("citation_records_turn_number_idx").on(
      table.turnId,
      table.citationNumber,
    ),
    index("citation_records_version_idx").on(table.documentVersionId),
  ],
);

export const researchStatements = pgTable(
  "research_statements",
  {
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    id: uuid("id").primaryKey(),
    presentation: answerPresentation("presentation").notNull(),
    section: answerSection("section").notNull(),
    statementIndex: integer("statement_index").notNull(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => researchTurns.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "research_statements_values_valid",
      sql`${table.statementIndex} >= 0
        AND length(trim(${table.content})) > 0`,
    ),
    unique("research_statements_turn_identity_unique").on(
      table.turnId,
      table.id,
    ),
    uniqueIndex("research_statements_turn_index_idx").on(
      table.turnId,
      table.statementIndex,
    ),
  ],
);

export const researchStatementCitations = pgTable(
  "research_statement_citations",
  {
    citationId: uuid("citation_id").notNull(),
    citationPosition: integer("citation_position").notNull(),
    statementId: uuid("statement_id").notNull(),
    turnId: uuid("turn_id").notNull(),
  },
  (table) => [
    check(
      "research_statement_citations_values_valid",
      sql`${table.citationPosition} >= 0`,
    ),
    foreignKey({
      columns: [table.turnId, table.citationId],
      foreignColumns: [citationRecords.turnId, citationRecords.id],
      name: "research_statement_citations_citation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.turnId, table.statementId],
      foreignColumns: [researchStatements.turnId, researchStatements.id],
      name: "research_statement_citations_statement_fk",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.turnId, table.statementId, table.citationPosition],
    }),
    unique("research_statement_citations_identity_unique").on(
      table.turnId,
      table.statementId,
      table.citationId,
    ),
  ],
);

export const researchClaimChecks = pgTable(
  "research_claim_checks",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    id: uuid("id").primaryKey(),
    rationale: text("rationale").notNull(),
    statementId: uuid("statement_id").notNull(),
    status: claimSupportStatus("status").notNull(),
    turnId: uuid("turn_id").notNull(),
    verifierModel: text("verifier_model").notNull(),
  },
  (table) => [
    check(
      "research_claim_checks_values_valid",
      sql`length(trim(${table.rationale})) > 0
        AND length(trim(${table.verifierModel})) > 0`,
    ),
    foreignKey({
      columns: [table.turnId, table.statementId],
      foreignColumns: [researchStatements.turnId, researchStatements.id],
      name: "research_claim_checks_statement_fk",
    }).onDelete("cascade"),
    unique("research_claim_checks_turn_identity_unique").on(
      table.turnId,
      table.id,
    ),
    uniqueIndex("research_claim_checks_statement_idx").on(
      table.turnId,
      table.statementId,
    ),
    unique("research_claim_checks_statement_identity_unique").on(
      table.turnId,
      table.id,
      table.statementId,
    ),
  ],
);

export const researchClaimEvidenceUnits = pgTable(
  "research_claim_evidence_units",
  {
    checkId: uuid("check_id").notNull(),
    citationId: uuid("citation_id").notNull(),
    evidencePosition: integer("evidence_position").notNull(),
    outcome: verificationOutcome("outcome").notNull(),
    rationale: text("rationale").notNull(),
    statementId: uuid("statement_id").notNull(),
    supportProbability: doublePrecision("support_probability"),
    turnId: uuid("turn_id").notNull(),
    unitId: text("unit_id").notNull(),
  },
  (table) => [
    check(
      "research_claim_evidence_units_values_valid",
      sql`${table.evidencePosition} >= 0
        AND length(trim(${table.rationale})) > 0
        AND length(trim(${table.unitId})) > 0
        AND (${table.supportProbability} IS NULL
          OR (${table.supportProbability} >= 0 AND ${table.supportProbability} <= 1))`,
    ),
    foreignKey({
      columns: [table.turnId, table.checkId, table.statementId],
      foreignColumns: [
        researchClaimChecks.turnId,
        researchClaimChecks.id,
        researchClaimChecks.statementId,
      ],
      name: "research_claim_evidence_units_check_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.turnId, table.statementId, table.citationId],
      foreignColumns: [
        researchStatementCitations.turnId,
        researchStatementCitations.statementId,
        researchStatementCitations.citationId,
      ],
      name: "research_claim_evidence_units_statement_citation_fk",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.turnId, table.checkId, table.evidencePosition],
    }),
    uniqueIndex("research_claim_evidence_units_identity_idx").on(
      table.turnId,
      table.checkId,
      table.citationId,
    ),
  ],
);

export const researchFeedback = pgTable(
  "research_feedback",
  {
    citationId: uuid("citation_id").references(() => citationRecords.id, {
      onDelete: "cascade",
    }),
    comment: text("comment"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    dimension: varchar("dimension", { length: 32 }).notNull(),
    id: uuid("id").primaryKey(),
    rating: integer("rating").notNull(),
    targetId: uuid("target_id").notNull(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => researchTurns.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("research_feedback_user_target_idx").on(
      table.userId,
      table.dimension,
      table.targetId,
    ),
  ],
);

export const doclingArtifacts = pgTable("docling_artifacts", {
  artifact: jsonb("artifact").$type<StoredDoclingArtifact>().notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  documentId: varchar("document_id", { length: 64 }).primaryKey(),
  processingTimeMs: integer("processing_time_ms").notNull(),
});

export const doclingTaskCheckpoints = pgTable(
  "docling_task_checkpoints",
  {
    deadlineAt: timestamp("deadline_at", { mode: "date", withTimezone: true })
      .notNull(),
    requestKey: varchar("request_key", { length: 128 }).notNull(),
    serviceInstanceId: varchar("service_instance_id", { length: 100 })
      .notNull()
      .references(() => doclingServiceInstances.id, { onDelete: "restrict" }),
    sourceFile: text("source_file")
      .notNull()
      .references(() => ingestionJobs.sourceFile, { onDelete: "cascade" }),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true })
      .notNull(),
    taskId: text("task_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceFile, table.requestKey] }),
    check(
      "docling_task_checkpoints_request_key_check",
      sql`length(trim(${table.requestKey})) > 0`,
    ),
    check(
      "docling_task_checkpoints_task_id_check",
      sql`length(trim(${table.taskId})) > 0`,
    ),
    check(
      "docling_task_checkpoints_deadline_check",
      sql`${table.deadlineAt} > ${table.submittedAt}`,
    ),
  ],
);

export const doclingConversionRuns = pgTable(
  "docling_conversion_runs",
  {
    attemptConfig: jsonb("attempt_config")
      .$type<DoclingAttemptConfigSnapshot>()
      .notNull(),
    byteLength: integer("byte_length").notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    configFingerprint: varchar("config_fingerprint", { length: 64 }).notNull(),
    documentId: varchar("document_id", { length: 64 }).notNull(),
    errorCategory: varchar("error_category", { length: 64 }),
    fileExtension: varchar("file_extension", { length: 8 }).notNull(),
    firstObservedStartedAt: timestamp("first_observed_started_at", {
      mode: "date",
      withTimezone: true,
    }),
    firstSubmittedAt: timestamp("first_submitted_at", {
      mode: "date",
      withTimezone: true,
    }),
    id: uuid("id").primaryKey(),
    imageCount: integer("image_count"),
    ingestionAttempt: integer("ingestion_attempt").notNull(),
    outcome: varchar("outcome", { length: 16 }),
    pageCount: integer("page_count"),
    processConfig: jsonb("process_config")
      .$type<DoclingProcessConfiguration>()
      .notNull(),
    providerProcessingMs: integer("provider_processing_ms"),
    resultRetrievalMs: integer("result_retrieval_ms"),
    schedulerAdmittedAt: timestamp("scheduler_admitted_at", {
      mode: "date",
      withTimezone: true,
    }),
    schedulerWaitMs: integer("scheduler_wait_ms"),
    serviceIdentity: jsonb("service_identity")
      .$type<DoclingServiceIdentity>()
      .notNull(),
    settingsVersion: integer("settings_version").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    tableCount: integer("table_count"),
    taskWaitMs: integer("task_wait_ms"),
    textCount: integer("text_count"),
    totalElementCount: integer("total_element_count"),
    totalWallMs: integer("total_wall_ms"),
    uploadMs: integer("upload_ms"),
  },
  (table) => [
    index("docling_conversion_runs_started_at_idx").on(table.startedAt),
    index("docling_conversion_runs_completed_at_idx").on(table.completedAt),
    index("docling_conversion_runs_document_idx").on(
      table.documentId,
      table.startedAt,
    ),
    index("docling_conversion_runs_outcome_idx").on(
      table.outcome,
      table.startedAt,
    ),
    check(
      "docling_conversion_runs_document_id_check",
      sql`${table.documentId} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "docling_conversion_runs_fingerprint_check",
      sql`${table.configFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "docling_conversion_runs_attempt_check",
      sql`${table.ingestionAttempt} > 0`,
    ),
    check(
      "docling_conversion_runs_completion_check",
      sql`(${table.completedAt} IS NULL AND ${table.outcome} IS NULL) OR (${table.completedAt} IS NOT NULL AND ${table.outcome} IS NOT NULL)`,
    ),
    check(
      "docling_conversion_runs_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('success', 'error', 'abort', 'timeout')`,
    ),
  ],
);

export const doclingConversionRequests = pgTable(
  "docling_conversion_requests",
  {
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    errorCategory: varchar("error_category", { length: 64 }),
    firstObservedStartedAt: timestamp("first_observed_started_at", {
      mode: "date",
      withTimezone: true,
    }),
    id: uuid("id").primaryKey(),
    kind: varchar("kind", { length: 32 }).notNull(),
    outcome: varchar("outcome", { length: 32 }),
    providerProcessingMs: integer("provider_processing_ms"),
    requestConfig: jsonb("request_config")
      .$type<DoclingEffectiveRequestOptions>()
      .notNull(),
    requestKey: varchar("request_key", { length: 128 }).notNull(),
    resultRetrievalMs: integer("result_retrieval_ms"),
    resumed: boolean("resumed").notNull().default(false),
    retryCount: integer("retry_count").notNull().default(0),
    runId: uuid("run_id")
      .notNull()
      .references(() => doclingConversionRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true }),
    taskId: text("task_id"),
    taskWaitMs: integer("task_wait_ms"),
    totalMs: integer("total_ms"),
    uploadMs: integer("upload_ms"),
  },
  (table) => [
    uniqueIndex("docling_conversion_requests_run_sequence_idx").on(
      table.runId,
      table.sequence,
    ),
    index("docling_conversion_requests_task_idx").on(table.taskId),
    check(
      "docling_conversion_requests_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "docling_conversion_requests_completion_check",
      sql`(${table.completedAt} IS NULL AND ${table.outcome} IS NULL) OR (${table.completedAt} IS NOT NULL AND ${table.outcome} IS NOT NULL)`,
    ),
    check(
      "docling_conversion_requests_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('success', 'service-error', 'transport-error', 'abort', 'timeout')`,
    ),
  ],
);

export const doclingProfilingStages = pgTable(
  "docling_profiling_stages",
  {
    count: integer("count").notNull(),
    id: uuid("id").primaryKey(),
    maximumDurationMs: doublePrecision("maximum_duration_ms").notNull(),
    medianDurationMs: doublePrecision("median_duration_ms").notNull(),
    minimumDurationMs: doublePrecision("minimum_duration_ms").notNull(),
    p95DurationMs: doublePrecision("p95_duration_ms").notNull(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => doclingConversionRequests.id, {
        onDelete: "cascade",
      }),
    scope: varchar("scope", { length: 16 }).notNull(),
    stage: varchar("stage", { length: 200 }).notNull(),
    totalDurationMs: doublePrecision("total_duration_ms").notNull(),
  },
  (table) => [
    index("docling_profiling_stages_request_idx").on(table.requestId),
  ],
);

export const retrievalDescriptionArtifacts = pgTable(
  "retrieval_description_artifacts",
  {
    description: jsonb("description").$type<RetrievalDescriptionRecord>().notNull(),
    documentId: varchar("document_id", { length: 64 }).notNull(),
    generationId: uuid("generation_id").notNull(),
    id: varchar("id", { length: 76 }).notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.generationId, table.id] }),
    uniqueIndex("retrieval_description_generation_position_idx").on(
      table.generationId,
      table.position,
    ),
    index("retrieval_description_document_id_idx").on(table.documentId),
  ],
);

export const retrievalTocArtifacts = pgTable(
  "retrieval_toc_artifacts",
  {
    artifact: jsonb("artifact").$type<DocumentTocArtifact>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    documentId: varchar("document_id", { length: 64 }).notNull(),
    elementSetId: varchar("element_set_id", { length: 64 })
      .notNull()
      .references(() => documentElementSets.id, { onDelete: "restrict" }),
    generationId: uuid("generation_id").primaryKey(),
    sourceFile: text("source_file").notNull(),
  },
  (table) => [
    index("retrieval_toc_document_idx").on(table.documentId),
  ],
);

function createRetrievalMetadataColumns() {
  return {
    documentId: varchar("document_id", { length: 64 }).notNull(),
    embeddingSpaceId: text("embedding_space_id")
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: "cascade" }),
    evidenceContent: text("evidence_content").notNull(),
    generationId: uuid("generation_id").notNull(),
    id: varchar("id", { length: 76 }).notNull(),
    kind: elementKind("kind").notNull(),
    nextRetrievalId: varchar("next_retrieval_id", { length: 64 }),
    pageNumber: integer("page_number"),
    parentId: varchar("parent_id", { length: 64 }).notNull(),
    previousRetrievalId: varchar("previous_retrieval_id", { length: 64 }),
    representationType: varchar("representation_type", { length: 32 })
      .$type<
        | "exact-window"
        | "image-description"
        | "table-description"
      >()
      .notNull(),
    sourceFile: text("source_file").notNull(),
  };
}

function createActiveRetrievalIdentityColumns() {
  return {
    documentId: varchar("document_id", { length: 64 }).notNull(),
    embeddingSpaceId: text("embedding_space_id")
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: "cascade" }),
    generationId: uuid("generation_id").notNull(),
    representationId: varchar("representation_id", { length: 76 }).notNull(),
    sourceFile: text("source_file").notNull(),
  };
}

interface ActiveProjectionAuthorityColumns {
  documentId: ExtraConfigColumn;
  embeddingSpaceId: ExtraConfigColumn;
  generationId: ExtraConfigColumn;
  sourceFile: ExtraConfigColumn;
}

function createActiveProjectionAuthorityForeignKey(
  table: ActiveProjectionAuthorityColumns,
  name: string,
) {
  return foreignKey({
    columns: [
      table.sourceFile,
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ],
    foreignColumns: [
      indexedDocumentSpaces.sourceFile,
      indexedDocumentSpaces.embeddingSpaceId,
      indexedDocumentSpaces.generationId,
      indexedDocumentSpaces.documentId,
    ],
    name,
  }).onDelete("cascade");
}

export const activeRetrievalChunks384 = pgTable(
  "active_retrieval_chunks_384",
  {
    ...createActiveRetrievalIdentityColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_384,
    }).notNull(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_chunks_384_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.representationId,
      ],
    }),
    index("active_retrieval_chunks_384_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("active_retrieval_chunks_384_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const activeRetrievalChunks768 = pgTable(
  "active_retrieval_chunks",
  {
    ...createActiveRetrievalIdentityColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_768,
    }).notNull(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_chunks_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.representationId,
      ],
    }),
    index("active_retrieval_chunks_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("active_retrieval_chunks_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const activeRetrievalChunks1024 = pgTable(
  "active_retrieval_chunks_1024",
  {
    ...createActiveRetrievalIdentityColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_1024,
    }).notNull(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_chunks_1024_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.representationId,
      ],
    }),
    index("active_retrieval_chunks_1024_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("active_retrieval_chunks_1024_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const activeRetrievalChunks1536 = pgTable(
  "active_retrieval_chunks_1536",
  {
    ...createActiveRetrievalIdentityColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_1536,
    }).notNull(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_chunks_1536_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.representationId,
      ],
    }),
    index("active_retrieval_chunks_1536_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("active_retrieval_chunks_1536_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const activeRetrievalChunks2048 = pgTable(
  "active_retrieval_chunks_2048",
  {
    ...createActiveRetrievalIdentityColumns(),
    embedding: halfvec("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_2048,
    }).notNull(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_chunks_2048_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.representationId,
      ],
    }),
    index("active_retrieval_chunks_2048_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("active_retrieval_chunks_2048_hnsw_idx")
      .using("hnsw", table.embedding.op("halfvec_cosine_ops")),
  ],
);

export const activeRetrievalLexicalChunks = pgTable(
  "active_retrieval_lexical_chunks",
  {
    content: text("content").notNull(),
    ...createActiveRetrievalIdentityColumns(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_lexical_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.representationId,
      ],
    }),
    index("active_retrieval_lexical_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("active_retrieval_lexical_bm25_idx")
      .using("bm25", table.content)
      .with({ text_config: "english" }),
  ],
);

export const activeRetrievalRoutes = pgTable(
  "active_retrieval_routes",
  {
    ...createActiveRetrievalIdentityColumns(),
    evidenceId: varchar("evidence_id", { length: 76 }),
    evidenceMode: varchar("evidence_mode", { length: 24 })
      .$type<"direct" | "parent-exact">()
      .notNull(),
    kind: elementKind("kind").notNull(),
    parentId: varchar("parent_id", { length: 64 }).notNull(),
    representationContent: text("representation_content").notNull(),
    representationType: varchar("representation_type", { length: 32 })
      .$type<
        | "exact-window"
        | "image-description"
        | "table-description"
      >()
      .notNull(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_routes_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.representationId,
      ],
    }),
    index("active_retrieval_routes_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    check(
      "active_retrieval_routes_evidence_check",
      sql`(
        ${table.evidenceMode} = 'direct'
        AND ${table.evidenceId} IS NOT NULL
      ) OR (
        ${table.evidenceMode} = 'parent-exact'
        AND ${table.evidenceId} IS NULL
      )`,
    ),
  ],
);

export const activeRetrievalEvidence = pgTable(
  "active_retrieval_evidence",
  {
    documentId: varchar("document_id", { length: 64 }).notNull(),
    embeddingSpaceId: text("embedding_space_id")
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: "cascade" }),
    evidenceContent: text("evidence_content").notNull(),
    evidenceId: varchar("evidence_id", { length: 76 }).notNull(),
    generationId: uuid("generation_id").notNull(),
    kind: elementKind("kind").notNull(),
    nextRetrievalId: varchar("next_retrieval_id", { length: 64 }),
    pageNumber: integer("page_number"),
    parentId: varchar("parent_id", { length: 64 }).notNull(),
    previousRetrievalId: varchar("previous_retrieval_id", { length: 64 }),
    sourceFile: text("source_file").notNull(),
  },
  (table) => [
    createActiveProjectionAuthorityForeignKey(
      table,
      "active_retrieval_evidence_publication_fk",
    ),
    primaryKey({
      columns: [
        table.embeddingSpaceId,
        table.generationId,
        table.evidenceId,
      ],
    }),
    index("active_retrieval_evidence_scope_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("active_retrieval_evidence_parent_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.parentId,
    ),
  ],
);

export const retrievalChunks384 = pgTable(
  "retrieval_chunks_384",
  {
    ...createRetrievalMetadataColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_384,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.embeddingSpaceId, table.generationId, table.id],
    }),
    index("retrieval_chunks_384_document_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("retrieval_chunks_384_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const retrievalChunks768 = pgTable(
  "retrieval_chunks",
  {
    ...createRetrievalMetadataColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_768,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.embeddingSpaceId, table.generationId, table.id],
    }),
    index("retrieval_chunks_document_id_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("retrieval_chunks_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const retrievalChunks = retrievalChunks768;

export const retrievalChunks1024 = pgTable(
  "retrieval_chunks_1024",
  {
    ...createRetrievalMetadataColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_1024,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.embeddingSpaceId, table.generationId, table.id],
    }),
    index("retrieval_chunks_1024_document_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("retrieval_chunks_1024_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const retrievalChunks1536 = pgTable(
  "retrieval_chunks_1536",
  {
    ...createRetrievalMetadataColumns(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_1536,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.embeddingSpaceId, table.generationId, table.id],
    }),
    index("retrieval_chunks_1536_document_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("retrieval_chunks_1536_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const retrievalChunks2048 = pgTable(
  "retrieval_chunks_2048",
  {
    ...createRetrievalMetadataColumns(),
    embedding: halfvec("embedding", {
      dimensions: EMBEDDING_DIMENSIONS.DIMENSION_2048,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.embeddingSpaceId, table.generationId, table.id],
    }),
    index("retrieval_chunks_2048_document_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("retrieval_chunks_2048_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("halfvec_cosine_ops")),
  ],
);

export const retrievalLexicalChunks = pgTable(
  "retrieval_lexical_chunks",
  {
    content: text("content").notNull(),
    ...createRetrievalMetadataColumns(),
  },
  (table) => [
    primaryKey({
      columns: [table.embeddingSpaceId, table.generationId, table.id],
    }),
    index("retrieval_lexical_chunks_document_idx").on(
      table.embeddingSpaceId,
      table.generationId,
      table.documentId,
    ),
    index("retrieval_lexical_chunks_content_bm25_idx")
      .using("bm25", table.content)
      .with({ text_config: "english" }),
  ],
);

export const inferenceLimits = pgTable("inference_limits", {
  backgroundProgressIntervalMs: integer("background_progress_interval_ms")
    .notNull()
    .default(5_000),
  backgroundStartedAt: timestamp("background_started_at", {
    mode: "date",
    withTimezone: true,
  }).notNull().defaultNow(),
  capacity: integer("capacity").notNull(),
  resourceGroup: text("resource").primaryKey(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const inferenceSlots = pgTable(
  "inference_slots",
  {
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    ownerId: uuid("owner_id"),
    resourceGroup: text("resource").notNull(),
    slotNumber: integer("slot_number").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.resourceGroup, table.slotNumber] }),
    index("inference_slots_availability_idx").on(
      table.resourceGroup,
      table.slotNumber,
      table.leaseExpiresAt,
    ),
  ],
);

export const inferenceQueue = pgTable(
  "inference_queue",
  {
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    queuedAt: timestamp("queued_at", { mode: "date", withTimezone: true })
      .notNull(),
    resourceGroup: text("resource_group").notNull(),
    workload: inferenceWorkload("workload").notNull(),
  },
  (table) => [
    index("inference_queue_admission_idx").on(
      table.resourceGroup,
      table.workload,
      table.queuedAt,
      table.id,
    ),
    index("inference_queue_expiry_idx").on(table.expiresAt),
  ],
);

export const inferenceSchedulingEvents = pgTable(
  "inference_scheduling_events",
  {
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    executionDurationMs: integer("execution_duration_ms"),
    id: uuid("id").primaryKey(),
    outcome: telemetryRunOutcome("outcome").notNull(),
    queueWaitMs: integer("queue_wait_ms").notNull(),
    queuedAt: timestamp("queued_at", { mode: "date", withTimezone: true })
      .notNull(),
    resourceGroup: text("resource_group").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    workload: inferenceWorkload("workload").notNull(),
  },
  (table) => [
    index("inference_scheduling_events_completed_idx").on(table.completedAt),
    index("inference_scheduling_events_group_workload_idx").on(
      table.resourceGroup,
      table.workload,
      table.completedAt,
    ),
  ],
);

export const telemetryRuns = pgTable(
  "telemetry_runs",
  {
    answerBudget: jsonb("answer_budget").$type<AnswerBudgetTelemetry>(),
    candidateBudget: jsonb("candidate_budget").$type<CandidateBudgetTelemetry>(),
    candidateCount: integer("candidate_count"),
    contextSelection: jsonb("context_selection").$type<ContextSelectionTelemetry>(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    durationMs: integer("duration_ms"),
    embeddingSpaceId: text("embedding_space_id").notNull(),
    fallbackCount: integer("fallback_count").notNull().default(0),
    hydratedContextCount: integer("hydrated_context_count"),
    id: uuid("id").primaryKey(),
    inputTokens: integer("input_tokens"),
    kind: telemetryRunKind("kind").notNull(),
    outcome: telemetryRunOutcome("outcome"),
    outputTokens: integer("output_tokens"),
    queryVariantCount: integer("query_variant_count"),
    retrievalSufficiencyModelId: text("retrieval_sufficiency_model_id"),
    retrievalSufficiencyOutcome: text("retrieval_sufficiency_outcome"),
    retrievalSufficiencyReason: text("retrieval_sufficiency_reason"),
    retrievalSufficiencyScore: doublePrecision("retrieval_sufficiency_score"),
    retrievalMode: text("retrieval_mode").notNull(),
    scopeSize: integer("scope_size"),
    settingsVersion: integer("settings_version").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull(),
    streamDurationMs: integer("stream_duration_ms"),
    timeToFirstTokenMs: integer("time_to_first_token_ms"),
    workloadId: text("workload_id"),
  },
  (table) => [
    index("telemetry_runs_started_at_idx").on(table.startedAt),
    index("telemetry_runs_kind_outcome_idx").on(table.kind, table.outcome),
  ],
);

export const telemetryStages = pgTable(
  "telemetry_stages",
  {
    durationMs: integer("duration_ms").notNull(),
    fallback: boolean("fallback").notNull().default(false),
    id: uuid("id").primaryKey(),
    inputCount: integer("input_count"),
    inputTokens: integer("input_tokens"),
    modelId: text("model_id"),
    name: text("name").notNull(),
    outcome: telemetryStageOutcome("outcome").notNull(),
    outputCount: integer("output_count"),
    outputTokens: integer("output_tokens"),
    provider: text("provider"),
    providerDurationMs: integer("provider_duration_ms"),
    retrievalMode: text("retrieval_mode"),
    runId: uuid("run_id")
      .notNull()
      .references(() => telemetryRuns.id, { onDelete: "cascade" }),
    schedulerWaitMs: integer("scheduler_wait_ms"),
    sequence: integer("sequence").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull(),
  },
  (table) => [
    index("telemetry_stages_run_sequence_idx").on(
      table.runId,
      table.sequence,
    ),
    index("telemetry_stages_started_at_idx").on(table.startedAt),
    index("telemetry_stages_name_model_idx").on(table.name, table.modelId),
  ],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  heartbeatAt: timestamp("heartbeat_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  hostname: text("hostname").notNull(),
  id: uuid("id").primaryKey(),
  processId: integer("process_id").notNull(),
  startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  state: workerState("state").notNull().default("starting"),
});
