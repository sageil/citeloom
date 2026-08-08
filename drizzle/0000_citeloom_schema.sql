CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_textsearch;--> statement-breakpoint

CREATE TYPE "public"."answer_presentation" AS ENUM('paragraph', 'bullet');--> statement-breakpoint
CREATE TYPE "public"."answer_section" AS ENUM('answer', 'key-points', 'conflicting-evidence');--> statement-breakpoint
CREATE TYPE "public"."application_error_origin" AS ENUM('http-request', 'streaming-answer', 'ingestion', 'inference-provider', 'worker', 'scheduler', 'background-task', 'settings-reload', 'database-operation', 'startup', 'cli', 'docling-transport', 'docling-task', 'docling-conversion', 'docling-normalization', 'docling-element');--> statement-breakpoint
CREATE TYPE "public"."application_error_severity" AS ENUM('warning', 'error', 'critical');--> statement-breakpoint
CREATE TYPE "public"."chat_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."chat_run_state" AS ENUM('accepted', 'embedding', 'retrieving', 'generating', 'verifying', 'publishing', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."chat_verification_job_state" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."claim_support_status" AS ENUM('partially-supported', 'supported', 'unsupported', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."docling_service_state" AS ENUM('active', 'unavailable', 'draining');--> statement-breakpoint
CREATE TYPE "public"."element_kind" AS ENUM('text', 'table', 'image');--> statement-breakpoint
CREATE TYPE "public"."inference_workload" AS ENUM('offline-tool', 'ingestion', 'interactive-answer', 'interactive-search', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."ingestion_control_state" AS ENUM('active', 'pause_requested', 'paused', 'cancel_requested', 'cleanup_failed');--> statement-breakpoint
CREATE TYPE "public"."ingestion_indexing_activity" AS ENUM('preparing', 'describing', 'embedding', 'building_outline');--> statement-breakpoint
CREATE TYPE "public"."ingestion_phase" AS ENUM('discovered', 'normalized', 'indexed');--> statement-breakpoint
CREATE TYPE "public"."ingestion_state" AS ENUM('pending', 'running', 'failed');--> statement-breakpoint
CREATE TYPE "public"."research_output_state" AS ENUM('building', 'published');--> statement-breakpoint
CREATE TYPE "public"."research_verification_job_state" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."telemetry_run_kind" AS ENUM('answer', 'benchmark', 'chat', 'retrieval', 'search');--> statement-breakpoint
CREATE TYPE "public"."telemetry_run_outcome" AS ENUM('success', 'error', 'abort');--> statement-breakpoint
CREATE TYPE "public"."telemetry_stage_outcome" AS ENUM('success', 'error', 'abort', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."user_account_state" AS ENUM('active', 'pending', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."verification_outcome" AS ENUM('not-evaluated', 'supported', 'unsupported', 'verifier-incompatible');--> statement-breakpoint
CREATE TYPE "public"."worker_state" AS ENUM('starting', 'idle', 'working', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "application_error_events" (
	"attempt_number" integer,
	"category" varchar(64) NOT NULL,
	"code" varchar(64) NOT NULL,
	"document_id" varchar(64),
	"id" uuid PRIMARY KEY NOT NULL,
	"instance" text,
	"job_id" text,
	"message" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"operation" varchar(128) NOT NULL,
	"origin" "application_error_origin" NOT NULL,
	"release" text,
	"request_id" text,
	"request_sequence" integer,
	"retryable" boolean,
	"run_id" text,
	"service" varchar(64) NOT NULL,
	"severity" "application_error_severity" NOT NULL,
	"source_file" text,
	"stack_fingerprint" varchar(64),
	"task_id" text,
	"workspace_id" text,
	CONSTRAINT "application_error_events_attempt_check" CHECK ("application_error_events"."attempt_number" IS NULL OR "application_error_events"."attempt_number" > 0),
	CONSTRAINT "application_error_events_request_sequence_check" CHECK ("application_error_events"."request_sequence" IS NULL OR "application_error_events"."request_sequence" >= 0),
	CONSTRAINT "application_error_events_category_check" CHECK (length(trim("application_error_events"."category")) > 0),
	CONSTRAINT "application_error_events_code_check" CHECK (length(trim("application_error_events"."code")) > 0),
	CONSTRAINT "application_error_events_message_check" CHECK (length(trim("application_error_events"."message")) > 0),
	CONSTRAINT "application_error_events_operation_check" CHECK (length(trim("application_error_events"."operation")) > 0),
	CONSTRAINT "application_error_events_service_check" CHECK (length(trim("application_error_events"."service")) > 0),
	CONSTRAINT "application_error_events_stack_fingerprint_check" CHECK ("application_error_events"."stack_fingerprint" IS NULL OR "application_error_events"."stack_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "application_revisions" (
	"channel" varchar(16) PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_revisions_values_valid" CHECK ("application_revisions"."channel" IN ('catalog', 'jobs', 'settings')
        AND "application_revisions"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "application_settings" (
	"defaults" jsonb NOT NULL,
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "application_settings_singleton_valid" CHECK ("application_settings"."id" = 'runtime' AND "application_settings"."version" > 0),
	CONSTRAINT "application_settings_documents_valid" CHECK (jsonb_typeof("application_settings"."defaults") = 'object'
        AND jsonb_typeof("application_settings"."defaults"->'providers') = 'object'
        AND jsonb_typeof("application_settings"."defaults"->'runtime') = 'object'
        AND COALESCE(jsonb_typeof("application_settings"."defaults"->'sourceContent'), '') = 'object'
        AND COALESCE(jsonb_typeof("application_settings"."defaults"#>'{sourceContent,directory}'), '') = 'string'
        AND COALESCE("application_settings"."defaults"#>>'{sourceContent,directory}', '') <> ''
        AND "application_settings"."defaults"->>'schemaVersion' = '1'
        AND jsonb_typeof("application_settings"."settings") = 'object'
        AND jsonb_typeof("application_settings"."settings"->'providers') = 'object'
        AND jsonb_typeof("application_settings"."settings"->'runtime') = 'object'
        AND COALESCE(jsonb_typeof("application_settings"."settings"->'sourceContent'), '') = 'object'
        AND COALESCE(jsonb_typeof("application_settings"."settings"#>'{sourceContent,directory}'), '') = 'string'
        AND COALESCE("application_settings"."settings"#>>'{sourceContent,directory}', '') <> ''
        AND "application_settings"."settings"->>'schemaVersion' = '1')
);
--> statement-breakpoint
CREATE TABLE "chat_citation_records" (
	"assistant_message_id" uuid NOT NULL,
	"citation_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"element_id" varchar(64) NOT NULL,
	"evidence" jsonb NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"image_content" "bytea",
	"page_numbers" integer[] NOT NULL,
	"regions" jsonb NOT NULL,
	"section_path" text[] NOT NULL,
	"source_file" text NOT NULL,
	CONSTRAINT "chat_citation_records_message_identity_unique" UNIQUE("assistant_message_id","id"),
	CONSTRAINT "chat_citation_records_values_check" CHECK ("chat_citation_records"."citation_number" > 0
        AND length(trim("chat_citation_records"."source_file")) > 0
        AND (
          ("chat_citation_records"."evidence"->>'kind' = 'image' AND "chat_citation_records"."image_content" IS NOT NULL)
          OR (
            "chat_citation_records"."evidence"->>'kind' IN ('table', 'text')
            AND "chat_citation_records"."image_content" IS NULL
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "chat_conversations" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"title" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "chat_conversations_title_check" CHECK (length(trim("chat_conversations"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "chat_evidence_documents" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"document_version_id" uuid PRIMARY KEY NOT NULL,
	"file_extension" varchar(33) NOT NULL,
	"media_type" text NOT NULL,
	"source_file" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "chat_evidence_documents_values_check" CHECK (length(trim("chat_evidence_documents"."source_file")) > 0 AND "chat_evidence_documents"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "chat_message_embeddings_1024" (
	"content" text NOT NULL,
	"embedding_space_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"part_ordinal" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	CONSTRAINT "chat_message_embeddings_1024_embedding_space_id_message_id_part_ordinal_pk" PRIMARY KEY("embedding_space_id","message_id","part_ordinal"),
	CONSTRAINT "chat_message_embeddings_1024_values_check" CHECK ("chat_message_embeddings_1024"."input_tokens" > 0 AND "chat_message_embeddings_1024"."part_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_message_embeddings_1536" (
	"content" text NOT NULL,
	"embedding_space_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"part_ordinal" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	CONSTRAINT "chat_message_embeddings_1536_embedding_space_id_message_id_part_ordinal_pk" PRIMARY KEY("embedding_space_id","message_id","part_ordinal"),
	CONSTRAINT "chat_message_embeddings_1536_values_check" CHECK ("chat_message_embeddings_1536"."input_tokens" > 0 AND "chat_message_embeddings_1536"."part_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_message_embeddings_2048" (
	"content" text NOT NULL,
	"embedding_space_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"part_ordinal" integer NOT NULL,
	"embedding" halfvec(2048) NOT NULL,
	CONSTRAINT "chat_message_embeddings_2048_embedding_space_id_message_id_part_ordinal_pk" PRIMARY KEY("embedding_space_id","message_id","part_ordinal"),
	CONSTRAINT "chat_message_embeddings_2048_values_check" CHECK ("chat_message_embeddings_2048"."input_tokens" > 0 AND "chat_message_embeddings_2048"."part_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_message_embeddings_384" (
	"content" text NOT NULL,
	"embedding_space_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"part_ordinal" integer NOT NULL,
	"embedding" vector(384) NOT NULL,
	CONSTRAINT "chat_message_embeddings_384_embedding_space_id_message_id_part_ordinal_pk" PRIMARY KEY("embedding_space_id","message_id","part_ordinal"),
	CONSTRAINT "chat_message_embeddings_384_values_check" CHECK ("chat_message_embeddings_384"."input_tokens" > 0 AND "chat_message_embeddings_384"."part_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_message_embeddings_768" (
	"content" text NOT NULL,
	"embedding_space_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"part_ordinal" integer NOT NULL,
	"embedding" vector(768) NOT NULL,
	CONSTRAINT "chat_message_embeddings_768_embedding_space_id_message_id_part_ordinal_pk" PRIMARY KEY("embedding_space_id","message_id","part_ordinal"),
	CONSTRAINT "chat_message_embeddings_768_values_check" CHECK ("chat_message_embeddings_768"."input_tokens" > 0 AND "chat_message_embeddings_768"."part_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"answer_document" jsonb,
	"claims" jsonb,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"role" "chat_message_role" NOT NULL,
	"run_id" uuid NOT NULL,
	CONSTRAINT "chat_messages_content_check" CHECK (length(trim("chat_messages"."content")) > 0),
	CONSTRAINT "chat_messages_output_check" CHECK ((
          "chat_messages"."role" = 'user'
          AND "chat_messages"."answer_document" IS NULL
          AND "chat_messages"."claims" IS NULL
        ) OR (
          "chat_messages"."role" = 'assistant'
          AND "chat_messages"."answer_document" IS NOT NULL
          AND "chat_messages"."claims" IS NOT NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "chat_runs" (
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"conversation_id" uuid NOT NULL,
	"error_message" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"memory_trace" jsonb,
	"retrieval_trace" jsonb,
	"run_configuration" jsonb,
	"sequence" integer NOT NULL,
	"state" "chat_run_state" DEFAULT 'accepted' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_runs_values_check" CHECK ("chat_runs"."attempt_count" > 0 AND "chat_runs"."sequence" > 0),
	CONSTRAINT "chat_runs_completion_check" CHECK ((
          "chat_runs"."state" IN ('completed', 'failed', 'canceled')
          AND "chat_runs"."completed_at" IS NOT NULL
          AND "chat_runs"."lease_expires_at" IS NULL
        ) OR (
          "chat_runs"."state" NOT IN ('completed', 'failed', 'canceled')
          AND "chat_runs"."completed_at" IS NULL
          AND "chat_runs"."lease_expires_at" IS NOT NULL
        )),
	CONSTRAINT "chat_runs_error_check" CHECK (("chat_runs"."state" = 'failed' AND "chat_runs"."error_message" IS NOT NULL)
        OR ("chat_runs"."state" <> 'failed' AND "chat_runs"."error_message" IS NULL)),
	CONSTRAINT "chat_runs_publication_check" CHECK ((
          "chat_runs"."state" = 'completed'
          AND "chat_runs"."memory_trace" IS NOT NULL
          AND "chat_runs"."retrieval_trace" IS NOT NULL
          AND "chat_runs"."run_configuration" IS NOT NULL
        ) OR (
          "chat_runs"."state" <> 'completed'
          AND "chat_runs"."memory_trace" IS NULL
          AND "chat_runs"."retrieval_trace" IS NULL
          AND "chat_runs"."run_configuration" IS NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "chat_verification_jobs" (
	"assistant_message_id" uuid PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"state" "chat_verification_job_state" DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_verification_jobs_counts_check" CHECK ("chat_verification_jobs"."attempt_count" >= 0 AND "chat_verification_jobs"."failure_count" >= 0),
	CONSTRAINT "chat_verification_jobs_state_check" CHECK ((
          "chat_verification_jobs"."state" = 'pending'
          AND "chat_verification_jobs"."completed_at" IS NULL
          AND "chat_verification_jobs"."lease_expires_at" IS NULL
        ) OR (
          "chat_verification_jobs"."state" = 'running'
          AND "chat_verification_jobs"."completed_at" IS NULL
          AND "chat_verification_jobs"."lease_expires_at" IS NOT NULL
        ) OR (
          "chat_verification_jobs"."state" IN ('completed', 'failed')
          AND "chat_verification_jobs"."completed_at" IS NOT NULL
          AND "chat_verification_jobs"."lease_expires_at" IS NULL
        )),
	CONSTRAINT "chat_verification_jobs_error_check" CHECK (("chat_verification_jobs"."state" = 'failed' AND "chat_verification_jobs"."error_message" IS NOT NULL)
        OR "chat_verification_jobs"."state" <> 'failed')
);
--> statement-breakpoint
CREATE TABLE "citation_records" (
	"citation_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"element_set_id" varchar(64) NOT NULL,
	"element_id" varchar(64) NOT NULL,
	"evidence" jsonb NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"page_numbers" integer[] NOT NULL,
	"regions" jsonb NOT NULL,
	"section_path" text[] NOT NULL,
	"source_file" text NOT NULL,
	"turn_id" uuid NOT NULL,
	CONSTRAINT "citation_records_turn_identity_unique" UNIQUE("turn_id","id"),
	CONSTRAINT "citation_records_values_valid" CHECK ("citation_records"."citation_number" > 0 AND length(trim("citation_records"."source_file")) > 0)
);
--> statement-breakpoint
CREATE TABLE "docling_artifacts" (
	"artifact" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" varchar(64) PRIMARY KEY NOT NULL,
	"processing_time_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docling_conversion_requests" (
	"completed_at" timestamp with time zone,
	"error_category" varchar(64),
	"first_observed_started_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"outcome" varchar(32),
	"provider_processing_ms" integer,
	"request_config" jsonb NOT NULL,
	"request_key" varchar(128) NOT NULL,
	"result_retrieval_ms" integer,
	"resumed" boolean DEFAULT false NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"task_id" text,
	"task_wait_ms" integer,
	"total_ms" integer,
	"upload_ms" integer,
	CONSTRAINT "docling_conversion_requests_sequence_check" CHECK ("docling_conversion_requests"."sequence" >= 0),
	CONSTRAINT "docling_conversion_requests_completion_check" CHECK (("docling_conversion_requests"."completed_at" IS NULL AND "docling_conversion_requests"."outcome" IS NULL) OR ("docling_conversion_requests"."completed_at" IS NOT NULL AND "docling_conversion_requests"."outcome" IS NOT NULL)),
	CONSTRAINT "docling_conversion_requests_outcome_check" CHECK ("docling_conversion_requests"."outcome" IS NULL OR "docling_conversion_requests"."outcome" IN ('success', 'service-error', 'transport-error', 'abort', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "docling_conversion_runs" (
	"attempt_config" jsonb NOT NULL,
	"byte_length" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"config_fingerprint" varchar(64) NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"error_category" varchar(64),
	"file_extension" varchar(8) NOT NULL,
	"first_observed_started_at" timestamp with time zone,
	"first_submitted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"image_count" integer,
	"ingestion_attempt" integer NOT NULL,
	"outcome" varchar(16),
	"page_count" integer,
	"process_config" jsonb NOT NULL,
	"provider_processing_ms" integer,
	"result_retrieval_ms" integer,
	"scheduler_admitted_at" timestamp with time zone,
	"scheduler_wait_ms" integer,
	"service_identity" jsonb NOT NULL,
	"settings_version" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"table_count" integer,
	"task_wait_ms" integer,
	"text_count" integer,
	"total_element_count" integer,
	"total_wall_ms" integer,
	"upload_ms" integer,
	CONSTRAINT "docling_conversion_runs_document_id_check" CHECK ("docling_conversion_runs"."document_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "docling_conversion_runs_fingerprint_check" CHECK ("docling_conversion_runs"."config_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "docling_conversion_runs_attempt_check" CHECK ("docling_conversion_runs"."ingestion_attempt" > 0),
	CONSTRAINT "docling_conversion_runs_completion_check" CHECK (("docling_conversion_runs"."completed_at" IS NULL AND "docling_conversion_runs"."outcome" IS NULL) OR ("docling_conversion_runs"."completed_at" IS NOT NULL AND "docling_conversion_runs"."outcome" IS NOT NULL)),
	CONSTRAINT "docling_conversion_runs_outcome_check" CHECK ("docling_conversion_runs"."outcome" IS NULL OR "docling_conversion_runs"."outcome" IN ('success', 'error', 'abort', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "docling_error_details" (
	"application_error_id" uuid NOT NULL,
	"category" varchar(64) NOT NULL,
	"component_type" varchar(64) NOT NULL,
	"docling_label" text,
	"element_kind" "element_kind",
	"message" text NOT NULL,
	"module_name" text NOT NULL,
	"page_number" integer,
	"page_range_end" integer,
	"page_range_start" integer,
	"sequence" integer NOT NULL,
	"source_ref" text,
	CONSTRAINT "docling_error_details_application_error_id_sequence_pk" PRIMARY KEY("application_error_id","sequence"),
	CONSTRAINT "docling_error_details_sequence_check" CHECK ("docling_error_details"."sequence" >= 0),
	CONSTRAINT "docling_error_details_page_check" CHECK ("docling_error_details"."page_number" IS NULL OR "docling_error_details"."page_number" > 0),
	CONSTRAINT "docling_error_details_range_check" CHECK (("docling_error_details"."page_range_start" IS NULL AND "docling_error_details"."page_range_end" IS NULL)
        OR ("docling_error_details"."page_range_start" > 0 AND "docling_error_details"."page_range_end" >= "docling_error_details"."page_range_start")),
	CONSTRAINT "docling_error_details_category_check" CHECK (length(trim("docling_error_details"."category")) > 0),
	CONSTRAINT "docling_error_details_component_check" CHECK (length(trim("docling_error_details"."component_type")) > 0),
	CONSTRAINT "docling_error_details_message_check" CHECK (length(trim("docling_error_details"."message")) > 0)
);
--> statement-breakpoint
CREATE TABLE "docling_profiling_stages" (
	"count" integer NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"maximum_duration_ms" double precision NOT NULL,
	"median_duration_ms" double precision NOT NULL,
	"minimum_duration_ms" double precision NOT NULL,
	"p95_duration_ms" double precision NOT NULL,
	"request_id" uuid NOT NULL,
	"scope" varchar(16) NOT NULL,
	"stage" varchar(200) NOT NULL,
	"total_duration_ms" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docling_service_instances" (
	"base_url" text NOT NULL,
	"capabilities_fingerprint" varchar(64),
	"capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_category" varchar(64),
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"last_verified_at" timestamp with time zone,
	"process_config" jsonb NOT NULL,
	"service_identity" jsonb,
	"state" "docling_service_state" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verification_config_fingerprint" varchar(64),
	CONSTRAINT "docling_service_instances_id_check" CHECK (length(trim("docling_service_instances"."id")) > 0),
	CONSTRAINT "docling_service_instances_base_url_check" CHECK (length(trim("docling_service_instances"."base_url")) > 0),
	CONSTRAINT "docling_service_instances_capacity_check" CHECK ("docling_service_instances"."capacity" > 0),
	CONSTRAINT "docling_service_instances_active_check" CHECK ("docling_service_instances"."state" <> 'active' OR ("docling_service_instances"."capabilities_fingerprint" IS NOT NULL AND "docling_service_instances"."service_identity" IS NOT NULL AND "docling_service_instances"."last_verified_at" IS NOT NULL AND "docling_service_instances"."verification_config_fingerprint" IS NOT NULL AND "docling_service_instances"."error_category" IS NULL)),
	CONSTRAINT "docling_service_instances_capabilities_fingerprint_check" CHECK ("docling_service_instances"."capabilities_fingerprint" IS NULL OR "docling_service_instances"."capabilities_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "docling_service_instances_verification_config_fingerprint_check" CHECK ("docling_service_instances"."verification_config_fingerprint" IS NULL OR "docling_service_instances"."verification_config_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "docling_task_checkpoints" (
	"deadline_at" timestamp with time zone NOT NULL,
	"request_key" varchar(128) NOT NULL,
	"service_instance_id" varchar(100) NOT NULL,
	"source_file" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"task_id" text NOT NULL,
	CONSTRAINT "docling_task_checkpoints_source_file_request_key_pk" PRIMARY KEY("source_file","request_key"),
	CONSTRAINT "docling_task_checkpoints_request_key_check" CHECK (length(trim("docling_task_checkpoints"."request_key")) > 0),
	CONSTRAINT "docling_task_checkpoints_task_id_check" CHECK (length(trim("docling_task_checkpoints"."task_id")) > 0),
	CONSTRAINT "docling_task_checkpoints_deadline_check" CHECK ("docling_task_checkpoints"."deadline_at" > "docling_task_checkpoints"."submitted_at")
);
--> statement-breakpoint
CREATE TABLE "document_element_set_members" (
	"element_id" varchar(64) NOT NULL,
	"position" integer NOT NULL,
	"set_id" varchar(64) NOT NULL,
	CONSTRAINT "document_element_set_members_set_id_position_pk" PRIMARY KEY("set_id","position"),
	CONSTRAINT "document_element_set_members_identity_unique" UNIQUE("set_id","element_id"),
	CONSTRAINT "document_element_set_members_position_check" CHECK ("document_element_set_members"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "document_element_sets" (
	"complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"element_count" integer NOT NULL,
	"id" varchar(64) PRIMARY KEY NOT NULL,
	CONSTRAINT "document_element_sets_element_count_check" CHECK ("document_element_sets"."element_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"element_set_id" varchar(64) NOT NULL,
	"file_extension" varchar(33) NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"images" integer NOT NULL,
	"media_type" text NOT NULL,
	"page_count" integer,
	"source_file" text NOT NULL,
	"tables" integer NOT NULL,
	"text_chunks" integer NOT NULL,
	"total_elements" integer NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "document_versions_identity_set_unique" UNIQUE("id","element_set_id")
);
--> statement-breakpoint
CREATE TABLE "embedding_input_formats" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_template" text NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"input_format_hash" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"query_template" text NOT NULL,
	"retired_at" timestamp with time zone,
	"schema_version" integer NOT NULL,
	CONSTRAINT "embedding_input_formats_values_valid" CHECK (length(trim("embedding_input_formats"."name")) > 0
        AND "embedding_input_formats"."schema_version" > 0
        AND length("embedding_input_formats"."document_template")
          - length(replace("embedding_input_formats"."document_template", '{{text}}', '')) = 8
        AND length("embedding_input_formats"."query_template")
          - length(replace("embedding_input_formats"."query_template", '{{text}}', '')) = 8
        AND "embedding_input_formats"."input_format_hash" ~ '^[a-f0-9]{64}$'
        AND ("embedding_input_formats"."retired_at" IS NULL OR "embedding_input_formats"."retired_at" >= "embedding_input_formats"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "embedding_space_gc_runs" (
	"active_space_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" varchar(16) NOT NULL,
	"retention_cutoff" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(16) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_space_gc_spaces" (
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"dimensions" integer NOT NULL,
	"disposition" varchar(16) NOT NULL,
	"error_message" text,
	"estimated_bytes" bigint NOT NULL,
	"input_format_hash" varchar(64) NOT NULL,
	"input_format_name" varchar(100) NOT NULL,
	"model" text NOT NULL,
	"profile" text NOT NULL,
	"protection_detail" text,
	"protection_kind" varchar(32),
	"row_counts" jsonb NOT NULL,
	"run_id" uuid NOT NULL,
	"space_id" text NOT NULL,
	"state" varchar(16) NOT NULL,
	CONSTRAINT "embedding_space_gc_spaces_run_id_space_id_pk" PRIMARY KEY("run_id","space_id")
);
--> statement-breakpoint
CREATE TABLE "embedding_space_pins" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"space_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_spaces" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dimensions" integer NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"input_format_document_template" text NOT NULL,
	"input_format_hash" varchar(64) NOT NULL,
	"input_format_id" uuid NOT NULL,
	"input_format_query_template" text NOT NULL,
	"input_format_schema_version" integer NOT NULL,
	"model" text NOT NULL,
	"profile" text NOT NULL,
	"retrieval_window_policy" jsonb NOT NULL,
	"retrieval_window_policy_fingerprint" varchar(64) NOT NULL,
	CONSTRAINT "embedding_spaces_retrieval_window_policy_fingerprint_valid" CHECK ("embedding_spaces"."retrieval_window_policy_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "embedding_spaces_input_format_snapshot_valid" CHECK ("embedding_spaces"."input_format_hash" ~ '^[a-f0-9]{64}$'
        AND "embedding_spaces"."input_format_schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "indexed_document_spaces" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_count" integer NOT NULL,
	"source_file" text NOT NULL,
	CONSTRAINT "indexed_document_spaces_source_file_embedding_space_id_pk" PRIMARY KEY("source_file","embedding_space_id"),
	CONSTRAINT "indexed_document_spaces_projection_identity_unique" UNIQUE("source_file","embedding_space_id","generation_id","document_id"),
	CONSTRAINT "indexed_document_spaces_representation_count_check" CHECK ("indexed_document_spaces"."representation_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "indexed_documents" (
	"document_id" varchar(64) NOT NULL,
	"element_set_id" varchar(64) NOT NULL,
	"generation_id" uuid NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"page_count" integer,
	"source_file" text PRIMARY KEY NOT NULL,
	"tables" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"text_chunks" integer DEFAULT 0 NOT NULL,
	"total_elements" integer DEFAULT 0 NOT NULL,
	"version_id" uuid NOT NULL,
	CONSTRAINT "indexed_documents_page_count_check" CHECK ("indexed_documents"."page_count" IS NULL OR "indexed_documents"."page_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "inference_limits" (
	"background_progress_interval_ms" integer DEFAULT 5000 NOT NULL,
	"background_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"capacity" integer NOT NULL,
	"resource" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_queue" (
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"resource_group" text NOT NULL,
	"workload" "inference_workload" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_scheduling_events" (
	"completed_at" timestamp with time zone NOT NULL,
	"execution_duration_ms" integer,
	"id" uuid PRIMARY KEY NOT NULL,
	"outcome" "telemetry_run_outcome" NOT NULL,
	"queue_wait_ms" integer NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"resource_group" text NOT NULL,
	"started_at" timestamp with time zone,
	"workload" "inference_workload" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_slots" (
	"lease_expires_at" timestamp with time zone,
	"owner_id" uuid,
	"resource" text NOT NULL,
	"slot_number" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_slots_resource_slot_number_pk" PRIMARY KEY("resource","slot_number")
);
--> statement-breakpoint
CREATE TABLE "ingestion_embedding_manifests" (
	"completed" boolean DEFAULT false NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"element_set_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"exact_representation_count" integer DEFAULT 0 NOT NULL,
	"generation_id" uuid PRIMARY KEY NOT NULL,
	"next_element_position" integer DEFAULT 0 NOT NULL,
	"retrieval_policy_fingerprint" varchar(64) NOT NULL,
	"description_representation_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_embedding_manifests_counts_check" CHECK ("ingestion_embedding_manifests"."next_element_position" >= 0 AND "ingestion_embedding_manifests"."exact_representation_count" >= 0 AND "ingestion_embedding_manifests"."description_representation_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"docling_attempt_config" jsonb,
	"docling_run_id" uuid,
	"docling_service_instance_id" varchar(100),
	"docling_service_slot" integer,
	"element_set_id" varchar(64),
	"embedding_space_id" text NOT NULL,
	"error_message" text,
	"file_extension" varchar(33) NOT NULL,
	"generation_id" uuid NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"indexing_activity" "ingestion_indexing_activity",
	"lease_expires_at" timestamp with time zone,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"media_type" text NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" uuid,
	"page_count" integer,
	"phase" "ingestion_phase" DEFAULT 'discovered' NOT NULL,
	"control_error" text,
	"control_state" "ingestion_control_state" DEFAULT 'active' NOT NULL,
	"source_file" text PRIMARY KEY NOT NULL,
	"state" "ingestion_state" DEFAULT 'pending' NOT NULL,
	"tables" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"text_chunks" integer DEFAULT 0 NOT NULL,
	"total_elements" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by_user_id" uuid,
	CONSTRAINT "ingestion_jobs_generation_idx" UNIQUE("generation_id"),
	CONSTRAINT "ingestion_jobs_docling_run_config_check" CHECK ("ingestion_jobs"."docling_run_id" IS NULL OR "ingestion_jobs"."docling_attempt_config" IS NOT NULL),
	CONSTRAINT "ingestion_jobs_docling_assignment_fields_check" CHECK (("ingestion_jobs"."docling_service_instance_id" IS NULL AND "ingestion_jobs"."docling_service_slot" IS NULL) OR ("ingestion_jobs"."docling_service_instance_id" IS NOT NULL AND "ingestion_jobs"."docling_service_slot" IS NOT NULL)),
	CONSTRAINT "ingestion_jobs_docling_assignment_phase_check" CHECK ("ingestion_jobs"."docling_service_instance_id" IS NULL OR "ingestion_jobs"."phase" = 'discovered'),
	CONSTRAINT "ingestion_jobs_docling_assignment_slot_check" CHECK ("ingestion_jobs"."docling_service_slot" IS NULL OR "ingestion_jobs"."docling_service_slot" > 0),
	CONSTRAINT "ingestion_jobs_page_count_check" CHECK ("ingestion_jobs"."page_count" IS NULL OR "ingestion_jobs"."page_count" > 0),
	CONSTRAINT "ingestion_jobs_indexing_activity_phase_check" CHECK (("ingestion_jobs"."phase" = 'normalized' AND "ingestion_jobs"."indexing_activity" IS NOT NULL) OR ("ingestion_jobs"."phase" <> 'normalized' AND "ingestion_jobs"."indexing_activity" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "provider_oauth_credentials" (
	"access_token" text NOT NULL,
	"account_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"provider_id" varchar(64) PRIMARY KEY NOT NULL,
	"refresh_token" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "provider_oauth_credentials_provider_valid" CHECK ("provider_oauth_credentials"."provider_id" = 'openai-codex'),
	CONSTRAINT "provider_oauth_credentials_values_valid" CHECK (length(trim("provider_oauth_credentials"."access_token")) > 0
        AND length(trim("provider_oauth_credentials"."refresh_token")) > 0
        AND length(trim("provider_oauth_credentials"."account_id")) > 0
        AND "provider_oauth_credentials"."status" IN ('connected', 'reauth-required')
        AND "provider_oauth_credentials"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "research_feedback" (
	"citation_id" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dimension" varchar(32) NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"rating" integer NOT NULL,
	"target_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_statement_citations" (
	"citation_id" uuid NOT NULL,
	"citation_position" integer NOT NULL,
	"statement_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	CONSTRAINT "research_statement_citations_turn_id_statement_id_citation_position_pk" PRIMARY KEY("turn_id","statement_id","citation_position"),
	CONSTRAINT "research_statement_citations_identity_unique" UNIQUE("turn_id","statement_id","citation_id"),
	CONSTRAINT "research_statement_citations_values_valid" CHECK ("research_statement_citations"."citation_position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_statements" (
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"presentation" "answer_presentation" NOT NULL,
	"section" "answer_section" NOT NULL,
	"statement_index" integer NOT NULL,
	"turn_id" uuid NOT NULL,
	CONSTRAINT "research_statements_turn_identity_unique" UNIQUE("turn_id","id"),
	CONSTRAINT "research_statements_values_valid" CHECK ("research_statements"."statement_index" >= 0
        AND length(trim("research_statements"."content")) > 0)
);
--> statement-breakpoint
CREATE TABLE "research_claim_checks" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"rationale" text NOT NULL,
	"statement_id" uuid NOT NULL,
	"status" "claim_support_status" NOT NULL,
	"turn_id" uuid NOT NULL,
	"verifier_model" text NOT NULL,
	CONSTRAINT "research_claim_checks_turn_identity_unique" UNIQUE("turn_id","id"),
	CONSTRAINT "research_claim_checks_statement_identity_unique" UNIQUE("turn_id","id","statement_id"),
	CONSTRAINT "research_claim_checks_values_valid" CHECK (length(trim("research_claim_checks"."rationale")) > 0
        AND length(trim("research_claim_checks"."verifier_model")) > 0)
);
--> statement-breakpoint
CREATE TABLE "research_claim_evidence_units" (
	"check_id" uuid NOT NULL,
	"citation_id" uuid NOT NULL,
	"evidence_position" integer NOT NULL,
	"outcome" "verification_outcome" NOT NULL,
	"rationale" text NOT NULL,
	"statement_id" uuid NOT NULL,
	"support_probability" double precision,
	"turn_id" uuid NOT NULL,
	"unit_id" text NOT NULL,
	CONSTRAINT "research_claim_evidence_units_turn_id_check_id_evidence_position_pk" PRIMARY KEY("turn_id","check_id","evidence_position"),
	CONSTRAINT "research_claim_evidence_units_values_valid" CHECK ("research_claim_evidence_units"."evidence_position" >= 0
        AND length(trim("research_claim_evidence_units"."rationale")) > 0
        AND length(trim("research_claim_evidence_units"."unit_id")) > 0
        AND ("research_claim_evidence_units"."support_probability" IS NULL
          OR ("research_claim_evidence_units"."support_probability" >= 0 AND "research_claim_evidence_units"."support_probability" <= 1)))
);
--> statement-breakpoint
CREATE TABLE "research_threads" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_turns" (
	"answer_schema_version" integer NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"answer_content" text,
	"question" text NOT NULL,
	"output_state" "research_output_state" NOT NULL,
	"retrieved_context" jsonb NOT NULL,
	"retrieval_trace" jsonb NOT NULL,
	"run_configuration" jsonb NOT NULL,
	"run_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"sequence" integer NOT NULL,
	"thread_id" uuid NOT NULL,
	CONSTRAINT "research_turns_answer_schema_version_check" CHECK ("research_turns"."answer_schema_version" = 2),
	CONSTRAINT "research_turns_answer_content_check" CHECK ("research_turns"."answer_content" IS NULL OR length(trim("research_turns"."answer_content")) > 0)
);
--> statement-breakpoint
CREATE TABLE "research_verification_jobs" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"state" "research_verification_job_state" DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_verification_jobs_counts_check" CHECK ("research_verification_jobs"."attempt_count" >= 0 AND "research_verification_jobs"."failure_count" >= 0),
	CONSTRAINT "research_verification_jobs_state_check" CHECK ((
          "research_verification_jobs"."state" = 'pending'
          AND "research_verification_jobs"."completed_at" IS NULL
          AND "research_verification_jobs"."lease_expires_at" IS NULL
        ) OR (
          "research_verification_jobs"."state" = 'running'
          AND "research_verification_jobs"."completed_at" IS NULL
          AND "research_verification_jobs"."lease_expires_at" IS NOT NULL
        ) OR (
          "research_verification_jobs"."state" IN ('completed', 'failed')
          AND "research_verification_jobs"."completed_at" IS NOT NULL
          AND "research_verification_jobs"."lease_expires_at" IS NULL
        )),
	CONSTRAINT "research_verification_jobs_error_check" CHECK (("research_verification_jobs"."state" = 'failed' AND "research_verification_jobs"."error_message" IS NOT NULL)
        OR "research_verification_jobs"."state" <> 'failed')
);
--> statement-breakpoint
CREATE TABLE "retrieval_chunks" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"evidence_content" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" varchar(76) NOT NULL,
	"kind" "element_kind" NOT NULL,
	"next_retrieval_id" varchar(64),
	"page_number" integer,
	"parent_id" varchar(64) NOT NULL,
	"previous_retrieval_id" varchar(64),
	"representation_type" varchar(32) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	CONSTRAINT "retrieval_chunks_embedding_space_id_generation_id_id_pk" PRIMARY KEY("embedding_space_id","generation_id","id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_chunks_1024" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"evidence_content" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" varchar(76) NOT NULL,
	"kind" "element_kind" NOT NULL,
	"next_retrieval_id" varchar(64),
	"page_number" integer,
	"parent_id" varchar(64) NOT NULL,
	"previous_retrieval_id" varchar(64),
	"representation_type" varchar(32) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	CONSTRAINT "retrieval_chunks_1024_embedding_space_id_generation_id_id_pk" PRIMARY KEY("embedding_space_id","generation_id","id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_chunks_1536" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"evidence_content" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" varchar(76) NOT NULL,
	"kind" "element_kind" NOT NULL,
	"next_retrieval_id" varchar(64),
	"page_number" integer,
	"parent_id" varchar(64) NOT NULL,
	"previous_retrieval_id" varchar(64),
	"representation_type" varchar(32) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	CONSTRAINT "retrieval_chunks_1536_embedding_space_id_generation_id_id_pk" PRIMARY KEY("embedding_space_id","generation_id","id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_chunks_2048" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"evidence_content" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" varchar(76) NOT NULL,
	"kind" "element_kind" NOT NULL,
	"next_retrieval_id" varchar(64),
	"page_number" integer,
	"parent_id" varchar(64) NOT NULL,
	"previous_retrieval_id" varchar(64),
	"representation_type" varchar(32) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" halfvec(2048) NOT NULL,
	CONSTRAINT "retrieval_chunks_2048_embedding_space_id_generation_id_id_pk" PRIMARY KEY("embedding_space_id","generation_id","id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_chunks_384" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"evidence_content" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" varchar(76) NOT NULL,
	"kind" "element_kind" NOT NULL,
	"next_retrieval_id" varchar(64),
	"page_number" integer,
	"parent_id" varchar(64) NOT NULL,
	"previous_retrieval_id" varchar(64),
	"representation_type" varchar(32) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	CONSTRAINT "retrieval_chunks_384_embedding_space_id_generation_id_id_pk" PRIMARY KEY("embedding_space_id","generation_id","id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_description_artifacts" (
	"description" jsonb NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" varchar(76) NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "retrieval_description_artifacts_generation_id_id_pk" PRIMARY KEY("generation_id","id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_lexical_chunks" (
	"content" text NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"evidence_content" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"id" varchar(76) NOT NULL,
	"kind" "element_kind" NOT NULL,
	"next_retrieval_id" varchar(64),
	"page_number" integer,
	"parent_id" varchar(64) NOT NULL,
	"previous_retrieval_id" varchar(64),
	"representation_type" varchar(32) NOT NULL,
	"source_file" text NOT NULL,
	CONSTRAINT "retrieval_lexical_chunks_embedding_space_id_generation_id_id_pk" PRIMARY KEY("embedding_space_id","generation_id","id")
);
--> statement-breakpoint
CREATE TABLE "retrieval_toc_artifacts" (
	"artifact" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"element_set_id" varchar(64) NOT NULL,
	"generation_id" uuid PRIMARY KEY NOT NULL,
	"source_file" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_content_deletions" (
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"document_id" varchar(64) PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"byte_length" bigint NOT NULL,
	"last_published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" varchar(64) PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_elements" (
	"document_id" varchar(64) NOT NULL,
	"element" jsonb NOT NULL,
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"image_content" "bytea",
	CONSTRAINT "source_elements_image_content_check" CHECK (
        CASE
          WHEN "source_elements"."element"->>'kind' = 'image'
            THEN "source_elements"."image_content" IS NOT NULL
              AND NOT ("source_elements"."element" ? 'content')
          WHEN "source_elements"."element"->>'kind' IN ('table', 'text')
            THEN "source_elements"."image_content" IS NULL
              AND "source_elements"."element" ? 'content'
          ELSE FALSE
        END
      )
);
--> statement-breakpoint
CREATE TABLE "telemetry_runs" (
	"answer_budget" jsonb,
	"candidate_budget" jsonb,
	"candidate_count" integer,
	"context_selection" jsonb,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"embedding_space_id" text NOT NULL,
	"fallback_count" integer DEFAULT 0 NOT NULL,
	"hydrated_context_count" integer,
	"id" uuid PRIMARY KEY NOT NULL,
	"input_tokens" integer,
	"kind" "telemetry_run_kind" NOT NULL,
	"outcome" "telemetry_run_outcome",
	"output_tokens" integer,
	"query_variant_count" integer,
	"retrieval_sufficiency_model_id" text,
	"retrieval_sufficiency_outcome" text,
	"retrieval_sufficiency_reason" text,
	"retrieval_sufficiency_score" double precision,
	"retrieval_mode" text NOT NULL,
	"scope_size" integer,
	"settings_version" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stream_duration_ms" integer,
	"time_to_first_token_ms" integer,
	"workload_id" text
);
--> statement-breakpoint
CREATE TABLE "telemetry_stages" (
	"duration_ms" integer NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"input_count" integer,
	"input_tokens" integer,
	"model_id" text,
	"name" text NOT NULL,
	"outcome" "telemetry_stage_outcome" NOT NULL,
	"output_count" integer,
	"output_tokens" integer,
	"provider" text,
	"provider_duration_ms" integer,
	"retrieval_mode" text,
	"run_id" uuid NOT NULL,
	"scheduler_wait_ms" integer,
	"sequence" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_password_credentials" (
	"password_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"active_workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idle_timeout_seconds" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_digest" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "user_sessions_token_digest_check" CHECK ("user_sessions"."token_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "user_sessions_expiry_check" CHECK ("user_sessions"."expires_at" > "user_sessions"."created_at"),
	CONSTRAINT "user_sessions_idle_timeout_check" CHECK ("user_sessions"."idle_timeout_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_setup_tokens" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"token_digest" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "user_setup_tokens_token_digest_check" CHECK ("user_setup_tokens"."token_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "user_setup_tokens_expiry_check" CHECK ("user_setup_tokens"."expires_at" > "user_setup_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"state" "user_account_state" DEFAULT 'pending' NOT NULL,
	"username" varchar(100) NOT NULL,
	"username_normalized" varchar(100) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_normalized_check" CHECK ("users"."username_normalized" = lower("users"."username_normalized") AND length(trim("users"."username_normalized")) > 0)
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hostname" text NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"process_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" "worker_state" DEFAULT 'starting' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" "workspace_role" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "workspace_memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(100) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_check" CHECK ("workspaces"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "active_retrieval_chunks_1024" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_id" varchar(76) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	CONSTRAINT "active_retrieval_chunks_1024_embedding_space_id_generation_id_representation_id_pk" PRIMARY KEY("embedding_space_id","generation_id","representation_id")
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
CREATE TABLE "active_retrieval_chunks_1536" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_id" varchar(76) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	CONSTRAINT "active_retrieval_chunks_1536_embedding_space_id_generation_id_representation_id_pk" PRIMARY KEY("embedding_space_id","generation_id","representation_id")
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
CREATE TABLE "active_retrieval_chunks_2048" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_id" varchar(76) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" halfvec(2048) NOT NULL,
	CONSTRAINT "active_retrieval_chunks_2048_embedding_space_id_generation_id_representation_id_pk" PRIMARY KEY("embedding_space_id","generation_id","representation_id")
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
CREATE TABLE "active_retrieval_chunks_384" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_id" varchar(76) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	CONSTRAINT "active_retrieval_chunks_384_embedding_space_id_generation_id_representation_id_pk" PRIMARY KEY("embedding_space_id","generation_id","representation_id")
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
CREATE TABLE "active_retrieval_chunks" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_id" varchar(76) NOT NULL,
	"source_file" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	CONSTRAINT "active_retrieval_chunks_embedding_space_id_generation_id_representation_id_pk" PRIMARY KEY("embedding_space_id","generation_id","representation_id")
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
CREATE TABLE "active_retrieval_evidence" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"evidence_content" text NOT NULL,
	"evidence_id" varchar(76) NOT NULL,
	"generation_id" uuid NOT NULL,
	"kind" "element_kind" NOT NULL,
	"next_retrieval_id" varchar(64),
	"page_number" integer,
	"parent_id" varchar(64) NOT NULL,
	"previous_retrieval_id" varchar(64),
	"source_file" text NOT NULL,
	CONSTRAINT "active_retrieval_evidence_embedding_space_id_generation_id_evidence_id_pk" PRIMARY KEY("embedding_space_id","generation_id","evidence_id")
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
CREATE TABLE "active_retrieval_lexical_chunks" (
	"content" text NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_id" varchar(76) NOT NULL,
	"source_file" text NOT NULL,
	CONSTRAINT "active_retrieval_lexical_chunks_embedding_space_id_generation_id_representation_id_pk" PRIMARY KEY("embedding_space_id","generation_id","representation_id")
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
CREATE TABLE "active_retrieval_routes" (
	"document_id" varchar(64) NOT NULL,
	"embedding_space_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"representation_id" varchar(76) NOT NULL,
	"source_file" text NOT NULL,
	"evidence_id" varchar(76),
	"evidence_mode" varchar(24) NOT NULL,
	"kind" "element_kind" NOT NULL,
	"parent_id" varchar(64) NOT NULL,
	"representation_content" text NOT NULL,
	"representation_type" varchar(32) NOT NULL,
	CONSTRAINT "active_retrieval_routes_embedding_space_id_generation_id_representation_id_pk" PRIMARY KEY("embedding_space_id","generation_id","representation_id"),
	CONSTRAINT "active_retrieval_routes_evidence_check" CHECK ((
        "active_retrieval_routes"."evidence_mode" = 'direct'
        AND "active_retrieval_routes"."evidence_id" IS NOT NULL
      ) OR (
        "active_retrieval_routes"."evidence_mode" = 'parent-exact'
        AND "active_retrieval_routes"."evidence_id" IS NULL
      ))
) PARTITION BY LIST ("embedding_space_id");
--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_1024" ADD CONSTRAINT "active_retrieval_chunks_1024_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_1024" ADD CONSTRAINT "active_retrieval_chunks_1024_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_1536" ADD CONSTRAINT "active_retrieval_chunks_1536_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_1536" ADD CONSTRAINT "active_retrieval_chunks_1536_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_2048" ADD CONSTRAINT "active_retrieval_chunks_2048_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_2048" ADD CONSTRAINT "active_retrieval_chunks_2048_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_384" ADD CONSTRAINT "active_retrieval_chunks_384_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks_384" ADD CONSTRAINT "active_retrieval_chunks_384_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks" ADD CONSTRAINT "active_retrieval_chunks_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_chunks" ADD CONSTRAINT "active_retrieval_chunks_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_evidence" ADD CONSTRAINT "active_retrieval_evidence_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_evidence" ADD CONSTRAINT "active_retrieval_evidence_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_lexical_chunks" ADD CONSTRAINT "active_retrieval_lexical_chunks_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_lexical_chunks" ADD CONSTRAINT "active_retrieval_lexical_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_routes" ADD CONSTRAINT "active_retrieval_routes_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_retrieval_routes" ADD CONSTRAINT "active_retrieval_routes_publication_fk" FOREIGN KEY ("source_file","embedding_space_id","generation_id","document_id") REFERENCES "public"."indexed_document_spaces"("source_file","embedding_space_id","generation_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_1024_scope_idx" ON "active_retrieval_chunks_1024" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_1024_hnsw_idx" ON "active_retrieval_chunks_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_1536_scope_idx" ON "active_retrieval_chunks_1536" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_1536_hnsw_idx" ON "active_retrieval_chunks_1536" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_2048_scope_idx" ON "active_retrieval_chunks_2048" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_2048_hnsw_idx" ON "active_retrieval_chunks_2048" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_384_scope_idx" ON "active_retrieval_chunks_384" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_384_hnsw_idx" ON "active_retrieval_chunks_384" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_scope_idx" ON "active_retrieval_chunks" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_chunks_hnsw_idx" ON "active_retrieval_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "active_retrieval_evidence_scope_idx" ON "active_retrieval_evidence" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_evidence_parent_idx" ON "active_retrieval_evidence" USING btree ("embedding_space_id","generation_id","parent_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_lexical_scope_idx" ON "active_retrieval_lexical_chunks" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "active_retrieval_lexical_bm25_idx" ON "active_retrieval_lexical_chunks" USING bm25 ("content") WITH (text_config=english);--> statement-breakpoint
CREATE INDEX "active_retrieval_routes_scope_idx" ON "active_retrieval_routes" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
ALTER TABLE "chat_citation_records" ADD CONSTRAINT "chat_citation_records_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_citation_records" ADD CONSTRAINT "chat_citation_records_document_version_id_chat_evidence_documents_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."chat_evidence_documents"("document_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_owner_membership_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_evidence_documents" ADD CONSTRAINT "chat_evidence_documents_document_id_source_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_1024" ADD CONSTRAINT "chat_message_embeddings_1024_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_1024" ADD CONSTRAINT "chat_message_embeddings_1024_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_1536" ADD CONSTRAINT "chat_message_embeddings_1536_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_1536" ADD CONSTRAINT "chat_message_embeddings_1536_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_2048" ADD CONSTRAINT "chat_message_embeddings_2048_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_2048" ADD CONSTRAINT "chat_message_embeddings_2048_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_384" ADD CONSTRAINT "chat_message_embeddings_384_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_384" ADD CONSTRAINT "chat_message_embeddings_384_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_768" ADD CONSTRAINT "chat_message_embeddings_768_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_768" ADD CONSTRAINT "chat_message_embeddings_768_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_verification_jobs" ADD CONSTRAINT "chat_verification_jobs_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_records" ADD CONSTRAINT "citation_records_turn_id_research_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."research_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_records" ADD CONSTRAINT "citation_records_version_element_set_fk" FOREIGN KEY ("document_version_id","element_set_id") REFERENCES "public"."document_versions"("id","element_set_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation_records" ADD CONSTRAINT "citation_records_element_set_member_fk" FOREIGN KEY ("element_set_id","element_id") REFERENCES "public"."document_element_set_members"("set_id","element_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docling_conversion_requests" ADD CONSTRAINT "docling_conversion_requests_run_id_docling_conversion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."docling_conversion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docling_error_details" ADD CONSTRAINT "docling_error_details_application_error_id_application_error_events_id_fk" FOREIGN KEY ("application_error_id") REFERENCES "public"."application_error_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docling_profiling_stages" ADD CONSTRAINT "docling_profiling_stages_request_id_docling_conversion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."docling_conversion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docling_task_checkpoints" ADD CONSTRAINT "docling_task_checkpoints_service_instance_id_docling_service_instances_id_fk" FOREIGN KEY ("service_instance_id") REFERENCES "public"."docling_service_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docling_task_checkpoints" ADD CONSTRAINT "docling_task_checkpoints_source_file_ingestion_jobs_source_file_fk" FOREIGN KEY ("source_file") REFERENCES "public"."ingestion_jobs"("source_file") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_element_set_members" ADD CONSTRAINT "document_element_set_members_element_id_source_elements_id_fk" FOREIGN KEY ("element_id") REFERENCES "public"."source_elements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_element_set_members" ADD CONSTRAINT "document_element_set_members_set_id_document_element_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."document_element_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_source_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_element_set_id_document_element_sets_id_fk" FOREIGN KEY ("element_set_id") REFERENCES "public"."document_element_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_space_gc_spaces" ADD CONSTRAINT "embedding_space_gc_spaces_run_id_embedding_space_gc_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."embedding_space_gc_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_space_pins" ADD CONSTRAINT "embedding_space_pins_space_id_embedding_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD CONSTRAINT "embedding_spaces_input_format_id_embedding_input_formats_id_fk" FOREIGN KEY ("input_format_id") REFERENCES "public"."embedding_input_formats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexed_document_spaces" ADD CONSTRAINT "indexed_document_spaces_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexed_documents" ADD CONSTRAINT "indexed_documents_document_id_source_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexed_documents" ADD CONSTRAINT "indexed_documents_element_set_id_document_element_sets_id_fk" FOREIGN KEY ("element_set_id") REFERENCES "public"."document_element_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexed_documents" ADD CONSTRAINT "indexed_documents_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_embedding_manifests" ADD CONSTRAINT "ingestion_embedding_manifests_element_set_id_document_element_sets_id_fk" FOREIGN KEY ("element_set_id") REFERENCES "public"."document_element_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_embedding_manifests" ADD CONSTRAINT "ingestion_embedding_manifests_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_embedding_manifests" ADD CONSTRAINT "ingestion_embedding_manifests_generation_id_ingestion_jobs_generation_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."ingestion_jobs"("generation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_document_id_source_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_docling_run_id_docling_conversion_runs_id_fk" FOREIGN KEY ("docling_run_id") REFERENCES "public"."docling_conversion_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_docling_service_instance_id_docling_service_instances_id_fk" FOREIGN KEY ("docling_service_instance_id") REFERENCES "public"."docling_service_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_element_set_id_document_element_sets_id_fk" FOREIGN KEY ("element_set_id") REFERENCES "public"."document_element_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_feedback" ADD CONSTRAINT "research_feedback_citation_id_citation_records_id_fk" FOREIGN KEY ("citation_id") REFERENCES "public"."citation_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_feedback" ADD CONSTRAINT "research_feedback_turn_id_research_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."research_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_feedback" ADD CONSTRAINT "research_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_claim_checks" ADD CONSTRAINT "research_claim_checks_statement_fk" FOREIGN KEY ("turn_id","statement_id") REFERENCES "public"."research_statements"("turn_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_claim_evidence_units" ADD CONSTRAINT "research_claim_evidence_units_check_fk" FOREIGN KEY ("turn_id","check_id","statement_id") REFERENCES "public"."research_claim_checks"("turn_id","id","statement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_claim_evidence_units" ADD CONSTRAINT "research_claim_evidence_units_statement_citation_fk" FOREIGN KEY ("turn_id","statement_id","citation_id") REFERENCES "public"."research_statement_citations"("turn_id","statement_id","citation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_statement_citations" ADD CONSTRAINT "research_statement_citations_citation_fk" FOREIGN KEY ("turn_id","citation_id") REFERENCES "public"."citation_records"("turn_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_statement_citations" ADD CONSTRAINT "research_statement_citations_statement_fk" FOREIGN KEY ("turn_id","statement_id") REFERENCES "public"."research_statements"("turn_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_statements" ADD CONSTRAINT "research_statements_turn_id_research_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."research_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_turns" ADD CONSTRAINT "research_turns_thread_id_research_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."research_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_verification_jobs" ADD CONSTRAINT "research_verification_jobs_turn_id_research_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."research_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_chunks_1024" ADD CONSTRAINT "retrieval_chunks_1024_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_chunks_1536" ADD CONSTRAINT "retrieval_chunks_1536_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_chunks_2048" ADD CONSTRAINT "retrieval_chunks_2048_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_chunks_384" ADD CONSTRAINT "retrieval_chunks_384_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_lexical_chunks" ADD CONSTRAINT "retrieval_lexical_chunks_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_toc_artifacts" ADD CONSTRAINT "retrieval_toc_artifacts_element_set_id_document_element_sets_id_fk" FOREIGN KEY ("element_set_id") REFERENCES "public"."document_element_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_stages" ADD CONSTRAINT "telemetry_stages_run_id_telemetry_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."telemetry_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_password_credentials" ADD CONSTRAINT "user_password_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_active_workspace_id_workspaces_id_fk" FOREIGN KEY ("active_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_setup_tokens" ADD CONSTRAINT "user_setup_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_setup_tokens" ADD CONSTRAINT "user_setup_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_error_events_occurred_at_idx" ON "application_error_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "application_error_events_workspace_occurred_idx" ON "application_error_events" USING btree ("workspace_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "application_error_events_workspace_origin_occurred_idx" ON "application_error_events" USING btree ("workspace_id","origin","occurred_at","id");--> statement-breakpoint
CREATE INDEX "application_error_events_service_operation_idx" ON "application_error_events" USING btree ("service","operation","occurred_at");--> statement-breakpoint
CREATE INDEX "application_error_events_job_idx" ON "application_error_events" USING btree ("job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "application_error_events_document_idx" ON "application_error_events" USING btree ("document_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_citation_records_message_number_idx" ON "chat_citation_records" USING btree ("assistant_message_id","citation_number");--> statement-breakpoint
CREATE INDEX "chat_citation_records_version_idx" ON "chat_citation_records" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "chat_conversations_owner_updated_idx" ON "chat_conversations" USING btree ("workspace_id","owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_evidence_documents_document_idx" ON "chat_evidence_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_1024_message_idx" ON "chat_message_embeddings_1024" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_1024_hnsw_idx" ON "chat_message_embeddings_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_1536_message_idx" ON "chat_message_embeddings_1536" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_1536_hnsw_idx" ON "chat_message_embeddings_1536" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_2048_message_idx" ON "chat_message_embeddings_2048" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_2048_hnsw_idx" ON "chat_message_embeddings_2048" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_384_message_idx" ON "chat_message_embeddings_384" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_384_hnsw_idx" ON "chat_message_embeddings_384" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_768_message_idx" ON "chat_message_embeddings_768" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_768_hnsw_idx" ON "chat_message_embeddings_768" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_run_role_idx" ON "chat_messages" USING btree ("run_id","role");--> statement-breakpoint
CREATE INDEX "chat_messages_run_created_idx" ON "chat_messages" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_runs_conversation_sequence_idx" ON "chat_runs" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "chat_runs_conversation_state_idx" ON "chat_runs" USING btree ("conversation_id","state");--> statement-breakpoint
CREATE INDEX "chat_verification_jobs_dispatch_idx" ON "chat_verification_jobs" USING btree ("state","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "citation_records_turn_number_idx" ON "citation_records" USING btree ("turn_id","citation_number");--> statement-breakpoint
CREATE INDEX "citation_records_version_idx" ON "citation_records" USING btree ("document_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docling_conversion_requests_run_sequence_idx" ON "docling_conversion_requests" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "docling_conversion_requests_task_idx" ON "docling_conversion_requests" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "docling_conversion_runs_started_at_idx" ON "docling_conversion_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "docling_conversion_runs_completed_at_idx" ON "docling_conversion_runs" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "docling_conversion_runs_document_idx" ON "docling_conversion_runs" USING btree ("document_id","started_at");--> statement-breakpoint
CREATE INDEX "docling_conversion_runs_outcome_idx" ON "docling_conversion_runs" USING btree ("outcome","started_at");--> statement-breakpoint
CREATE INDEX "docling_profiling_stages_request_idx" ON "docling_profiling_stages" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docling_service_instances_base_url_idx" ON "docling_service_instances" USING btree ("base_url");--> statement-breakpoint
CREATE INDEX "document_element_sets_document_idx" ON "document_element_sets" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_source_version_idx" ON "document_versions" USING btree ("source_file","version");--> statement-breakpoint
CREATE INDEX "document_versions_document_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "embedding_input_formats_retired_name_idx" ON "embedding_input_formats" USING btree ("retired_at","name");--> statement-breakpoint
CREATE INDEX "indexed_document_spaces_document_id_idx" ON "indexed_document_spaces" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "indexed_document_spaces_space_idx" ON "indexed_document_spaces" USING btree ("embedding_space_id");--> statement-breakpoint
CREATE INDEX "indexed_documents_document_id_idx" ON "indexed_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "indexed_documents_tags_gin_idx" ON "indexed_documents" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "inference_queue_admission_idx" ON "inference_queue" USING btree ("resource_group","workload","queued_at","id");--> statement-breakpoint
CREATE INDEX "inference_queue_expiry_idx" ON "inference_queue" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "inference_scheduling_events_completed_idx" ON "inference_scheduling_events" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "inference_scheduling_events_group_workload_idx" ON "inference_scheduling_events" USING btree ("resource_group","workload","completed_at");--> statement-breakpoint
CREATE INDEX "inference_slots_availability_idx" ON "inference_slots" USING btree ("resource","slot_number","lease_expires_at");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_document_id_idx" ON "ingestion_jobs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_control_state_idx" ON "ingestion_jobs" USING btree ("control_state","state");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_due_idx" ON "ingestion_jobs" USING btree ("state","next_attempt_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_jobs_docling_service_slot_idx" ON "ingestion_jobs" USING btree ("docling_service_instance_id","docling_service_slot") WHERE "ingestion_jobs"."docling_service_instance_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "research_feedback_user_target_idx" ON "research_feedback" USING btree ("user_id","dimension","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_claim_checks_statement_idx" ON "research_claim_checks" USING btree ("turn_id","statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_claim_evidence_units_identity_idx" ON "research_claim_evidence_units" USING btree ("turn_id","check_id","citation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_statements_turn_index_idx" ON "research_statements" USING btree ("turn_id","statement_index");--> statement-breakpoint
CREATE UNIQUE INDEX "research_turns_thread_sequence_idx" ON "research_turns" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "research_turns_run_idx" ON "research_turns" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "research_verification_jobs_dispatch_idx" ON "research_verification_jobs" USING btree ("state","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "retrieval_chunks_document_id_idx" ON "retrieval_chunks" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "retrieval_chunks_embedding_hnsw_idx" ON "retrieval_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "retrieval_chunks_1024_document_idx" ON "retrieval_chunks_1024" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "retrieval_chunks_1024_embedding_hnsw_idx" ON "retrieval_chunks_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "retrieval_chunks_1536_document_idx" ON "retrieval_chunks_1536" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "retrieval_chunks_1536_embedding_hnsw_idx" ON "retrieval_chunks_1536" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "retrieval_chunks_2048_document_idx" ON "retrieval_chunks_2048" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "retrieval_chunks_2048_embedding_hnsw_idx" ON "retrieval_chunks_2048" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "retrieval_chunks_384_document_idx" ON "retrieval_chunks_384" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "retrieval_chunks_384_embedding_hnsw_idx" ON "retrieval_chunks_384" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "retrieval_description_generation_position_idx" ON "retrieval_description_artifacts" USING btree ("generation_id","position");--> statement-breakpoint
CREATE INDEX "retrieval_description_document_id_idx" ON "retrieval_description_artifacts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "retrieval_lexical_chunks_document_idx" ON "retrieval_lexical_chunks" USING btree ("embedding_space_id","generation_id","document_id");--> statement-breakpoint
CREATE INDEX "retrieval_lexical_chunks_content_bm25_idx" ON "retrieval_lexical_chunks" USING bm25 ("content") WITH (text_config=english);--> statement-breakpoint
CREATE INDEX "retrieval_toc_document_idx" ON "retrieval_toc_artifacts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "source_content_deletions_requested_at_idx" ON "source_content_deletions" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "source_elements_document_id_idx" ON "source_elements" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "telemetry_runs_started_at_idx" ON "telemetry_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "telemetry_runs_kind_outcome_idx" ON "telemetry_runs" USING btree ("kind","outcome");--> statement-breakpoint
CREATE INDEX "telemetry_stages_run_sequence_idx" ON "telemetry_stages" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "telemetry_stages_started_at_idx" ON "telemetry_stages" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "telemetry_stages_name_model_idx" ON "telemetry_stages" USING btree ("name","model_id");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "user_sessions_expiry_idx" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_setup_tokens_user_idx" ON "user_setup_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_setup_tokens_expiry_idx" ON "user_setup_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_normalized_idx" ON "users" USING btree ("username_normalized");--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_idx" ON "workspaces" USING btree ("slug");--> statement-breakpoint

CREATE OR REPLACE FUNCTION "protect_retrieval_generation_rows"()
RETURNS trigger AS $retrieval_generation_immutability$
DECLARE
  generation_completed boolean;
  generation_document_id varchar(64);
  generation_embedding_space_id text;
  generation_source_file text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Canonical retrieval rows are immutable.';
  END IF;
  SELECT
    manifest."completed",
    manifest."document_id",
    manifest."embedding_space_id",
    job."source_file"
  INTO
    generation_completed,
    generation_document_id,
    generation_embedding_space_id,
    generation_source_file
  FROM "ingestion_embedding_manifests" manifest
  INNER JOIN "ingestion_jobs" job
    ON job."generation_id" = manifest."generation_id"
  WHERE manifest."generation_id" = NEW."generation_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Retrieval generation % has no manifest.', NEW."generation_id";
  END IF;
  IF generation_completed THEN
    RAISE EXCEPTION 'Retrieval generation % is sealed.', NEW."generation_id";
  END IF;
  IF NEW."document_id" <> generation_document_id
    OR NEW."embedding_space_id" <> generation_embedding_space_id
    OR NEW."source_file" <> generation_source_file THEN
    RAISE EXCEPTION 'Retrieval row does not match generation %.', NEW."generation_id";
  END IF;
  RETURN NEW;
END
$retrieval_generation_immutability$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "protect_completed_retrieval_manifest"()
RETURNS trigger AS $retrieval_manifest_completion$
BEGIN
  IF OLD."completed" AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Completed retrieval generation % is immutable.', OLD."generation_id";
  END IF;
  RETURN NEW;
END
$retrieval_manifest_completion$ LANGUAGE plpgsql;

CREATE TRIGGER "retrieval_chunks_384_generation_immutable"
BEFORE INSERT OR UPDATE ON "retrieval_chunks_384"
FOR EACH ROW EXECUTE FUNCTION "protect_retrieval_generation_rows"();

CREATE TRIGGER "retrieval_chunks_generation_immutable"
BEFORE INSERT OR UPDATE ON "retrieval_chunks"
FOR EACH ROW EXECUTE FUNCTION "protect_retrieval_generation_rows"();

CREATE TRIGGER "retrieval_chunks_1024_generation_immutable"
BEFORE INSERT OR UPDATE ON "retrieval_chunks_1024"
FOR EACH ROW EXECUTE FUNCTION "protect_retrieval_generation_rows"();

CREATE TRIGGER "retrieval_chunks_1536_generation_immutable"
BEFORE INSERT OR UPDATE ON "retrieval_chunks_1536"
FOR EACH ROW EXECUTE FUNCTION "protect_retrieval_generation_rows"();

CREATE TRIGGER "retrieval_chunks_2048_generation_immutable"
BEFORE INSERT OR UPDATE ON "retrieval_chunks_2048"
FOR EACH ROW EXECUTE FUNCTION "protect_retrieval_generation_rows"();

CREATE TRIGGER "retrieval_lexical_chunks_generation_immutable"
BEFORE INSERT OR UPDATE ON "retrieval_lexical_chunks"
FOR EACH ROW EXECUTE FUNCTION "protect_retrieval_generation_rows"();

CREATE TRIGGER "ingestion_embedding_manifests_completion_immutable"
BEFORE UPDATE ON "ingestion_embedding_manifests"
FOR EACH ROW EXECUTE FUNCTION "protect_completed_retrieval_manifest"();

CREATE OR REPLACE FUNCTION "publish_application_revision"() RETURNS trigger AS $$
DECLARE
  revision_channel text;
  revision_value bigint;
  transaction_marker text;
BEGIN
  revision_channel := TG_ARGV[0];
  transaction_marker := 'citeloom.revision.' || revision_channel;
  IF current_setting(transaction_marker, true) = 'published' THEN
    RETURN NULL;
  END IF;

  PERFORM set_config(transaction_marker, 'published', true);
  INSERT INTO "application_revisions" ("channel", "revision", "updated_at")
  VALUES (revision_channel, 1, now())
  ON CONFLICT ("channel") DO UPDATE
  SET "revision" = "application_revisions"."revision" + 1,
    "updated_at" = now()
  RETURNING "revision" INTO revision_value;

  PERFORM pg_notify(
    'citeloom_revisions',
    json_build_object(
      'channel', revision_channel,
      'revision', revision_value::text
    )::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "indexed_documents_publish_revision"
ON "indexed_documents";
CREATE TRIGGER "indexed_documents_publish_revision"
AFTER INSERT OR UPDATE OR DELETE ON "indexed_documents"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('catalog');

DROP TRIGGER IF EXISTS "indexed_document_spaces_publish_revision"
ON "indexed_document_spaces";
CREATE TRIGGER "indexed_document_spaces_publish_revision"
AFTER INSERT OR UPDATE OR DELETE ON "indexed_document_spaces"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('catalog');

DROP TRIGGER IF EXISTS "ingestion_jobs_publish_revision"
ON "ingestion_jobs";
CREATE TRIGGER "ingestion_jobs_publish_revision"
AFTER INSERT OR UPDATE OR DELETE ON "ingestion_jobs"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('jobs');

DROP TRIGGER IF EXISTS "ingestion_embedding_manifests_publish_revision"
ON "ingestion_embedding_manifests";
CREATE TRIGGER "ingestion_embedding_manifests_publish_revision"
AFTER INSERT OR UPDATE OR DELETE ON "ingestion_embedding_manifests"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('jobs');

DROP TRIGGER IF EXISTS "application_settings_publish_revision"
ON "application_settings";
CREATE TRIGGER "application_settings_publish_revision"
AFTER INSERT OR UPDATE OR DELETE ON "application_settings"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('settings');

CREATE OR REPLACE FUNCTION "assert_research_turn_output"("target_turn_id" uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  "answer_content" text;
  "claim_check_count" bigint;
  "citation_count" bigint;
  "citation_max" integer;
  "citation_min" integer;
  "link_count" bigint;
  "statement_count" bigint;
  "statement_max" integer;
  "statement_min" integer;
BEGIN
  SELECT "turn"."answer_content"
  INTO "answer_content"
  FROM "research_turns" AS "turn"
  WHERE "turn"."id" = "target_turn_id";

  SELECT count(*), min("citation_number"), max("citation_number")
  INTO "citation_count", "citation_min", "citation_max"
  FROM "citation_records"
  WHERE "turn_id" = "target_turn_id";

  SELECT count(*), min("statement_index"), max("statement_index")
  INTO "statement_count", "statement_min", "statement_max"
  FROM "research_statements"
  WHERE "turn_id" = "target_turn_id";

  SELECT count(*)
  INTO "link_count"
  FROM "research_statement_citations"
  WHERE "turn_id" = "target_turn_id";

  SELECT count(*)
  INTO "claim_check_count"
  FROM "research_claim_checks"
  WHERE "turn_id" = "target_turn_id";

  IF "answer_content" IS NULL THEN
    RAISE EXCEPTION 'Research turn % has no answer content.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF "citation_count" = 0 AND "statement_count" = 0 AND "link_count" = 0 THEN
    RETURN;
  END IF;

  IF "citation_count" = 0 OR "statement_count" = 0 OR "link_count" = 0 THEN
    RAISE EXCEPTION 'Research turn % has incomplete published output.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF "claim_check_count" <> "statement_count" THEN
    RAISE EXCEPTION 'Research turn % has incomplete claim verification.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF "citation_min" <> 1 OR "citation_max" <> "citation_count" THEN
    RAISE EXCEPTION 'Research turn % has non-contiguous citation numbers.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF "statement_min" <> 0 OR "statement_max" <> "statement_count" - 1 THEN
    RAISE EXCEPTION 'Research turn % has non-contiguous statement indexes.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "research_statements" AS "statement"
    WHERE
      "statement"."turn_id" = "target_turn_id"
      AND NOT EXISTS (
        SELECT 1
        FROM "research_statement_citations" AS "link"
        WHERE
          "link"."turn_id" = "statement"."turn_id"
          AND "link"."statement_id" = "statement"."id"
      )
  ) THEN
    RAISE EXCEPTION 'Research turn % contains an uncited statement.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "citation_records" AS "citation"
    WHERE
      "citation"."turn_id" = "target_turn_id"
      AND NOT EXISTS (
        SELECT 1
        FROM "research_statement_citations" AS "link"
        WHERE
          "link"."turn_id" = "citation"."turn_id"
          AND "link"."citation_id" = "citation"."id"
      )
  ) THEN
    RAISE EXCEPTION 'Research turn % contains an unreferenced citation.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "research_statement_citations"
    WHERE "turn_id" = "target_turn_id"
    GROUP BY "statement_id"
    HAVING
      min("citation_position") <> 0
      OR max("citation_position") <> count(*) - 1
  ) THEN
    RAISE EXCEPTION 'Research turn % has non-contiguous statement citation positions.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "research_claim_checks" AS "claim_check"
    WHERE
      "claim_check"."turn_id" = "target_turn_id"
      AND (
        SELECT count(*)
        FROM "research_statement_citations" AS "statement_citation"
        WHERE
          "statement_citation"."turn_id" = "claim_check"."turn_id"
          AND "statement_citation"."statement_id" = "claim_check"."statement_id"
      ) <> (
        SELECT count(*)
        FROM "research_claim_evidence_units" AS "evidence_unit"
        WHERE
          "evidence_unit"."turn_id" = "claim_check"."turn_id"
          AND "evidence_unit"."check_id" = "claim_check"."id"
      )
  ) THEN
    RAISE EXCEPTION 'Research turn % has incomplete claim verification evidence.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "research_claim_evidence_units"
    WHERE "turn_id" = "target_turn_id"
    GROUP BY "check_id"
    HAVING
      min("evidence_position") <> 0
      OR max("evidence_position") <> count(*) - 1
  ) THEN
    RAISE EXCEPTION 'Research turn % has non-contiguous claim evidence positions.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_research_turn_insert_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."output_state" <> 'building' THEN
    RAISE EXCEPTION 'Research turns must begin in the building state.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_research_turn_publication"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."output_state" <> 'building' OR NEW."output_state" <> 'published' THEN
    RAISE EXCEPTION 'Published research turns are immutable.'
      USING ERRCODE = '23514';
  END IF;

  IF
    (to_jsonb(NEW) - 'output_state')
    IS DISTINCT FROM
    (to_jsonb(OLD) - 'output_state')
  THEN
    RAISE EXCEPTION 'Research turn publication may only change output state.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM "assert_research_turn_output"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "require_published_research_turn"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "current_state" "research_output_state";
BEGIN
  SELECT "output_state"
  INTO "current_state"
  FROM "research_turns"
  WHERE "id" = NEW."id";

  IF FOUND AND "current_state" <> 'published' THEN
    RAISE EXCEPTION 'Research turn % was not published before commit.', NEW."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_research_output_child_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "current_state" "research_output_state";
  "target_turn_id" uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    "target_turn_id" := OLD."turn_id";
  ELSE
    "target_turn_id" := NEW."turn_id";
  END IF;

  SELECT "output_state"
  INTO "current_state"
  FROM "research_turns"
  WHERE "id" = "target_turn_id";

  IF NOT FOUND AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NOT FOUND OR "current_state" <> 'building' THEN
    RAISE EXCEPTION 'Published research output is immutable for turn %.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_research_verification_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "current_state" "research_output_state";
  "target_turn_id" uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    "target_turn_id" := OLD."turn_id";
  ELSE
    "target_turn_id" := NEW."turn_id";
  END IF;

  SELECT "output_state"
  INTO "current_state"
  FROM "research_turns"
  WHERE "id" = "target_turn_id";

  IF NOT FOUND AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF "current_state" = 'building' OR (
    "current_state" = 'published'
    AND EXISTS (
      SELECT 1
      FROM "research_verification_jobs"
      WHERE
        "turn_id" = "target_turn_id"
        AND "state" = 'running'
    )
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Published research verification is immutable without a running job for turn %.', "target_turn_id"
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS "research_turns_insert_state"
ON "research_turns";
CREATE TRIGGER "research_turns_insert_state"
BEFORE INSERT ON "research_turns"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_turn_insert_state"();

DROP TRIGGER IF EXISTS "research_turns_publish"
ON "research_turns";
CREATE TRIGGER "research_turns_publish"
BEFORE UPDATE ON "research_turns"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_turn_publication"();

DROP TRIGGER IF EXISTS "research_turns_require_published"
ON "research_turns";
CREATE CONSTRAINT TRIGGER "research_turns_require_published"
AFTER INSERT OR UPDATE ON "research_turns"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "require_published_research_turn"();

DROP TRIGGER IF EXISTS "citation_records_immutable_after_publication"
ON "citation_records";
CREATE TRIGGER "citation_records_immutable_after_publication"
BEFORE INSERT OR UPDATE OR DELETE ON "citation_records"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_output_child_mutation"();

DROP TRIGGER IF EXISTS "research_statements_immutable_after_publication"
ON "research_statements";
CREATE TRIGGER "research_statements_immutable_after_publication"
BEFORE INSERT OR UPDATE OR DELETE ON "research_statements"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_output_child_mutation"();

DROP TRIGGER IF EXISTS "research_statement_citations_immutable_after_publication"
ON "research_statement_citations";
CREATE TRIGGER "research_statement_citations_immutable_after_publication"
BEFORE INSERT OR UPDATE OR DELETE ON "research_statement_citations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_output_child_mutation"();

DROP TRIGGER IF EXISTS "research_claim_checks_immutable_after_publication"
ON "research_claim_checks";
CREATE TRIGGER "research_claim_checks_immutable_after_publication"
BEFORE INSERT OR UPDATE OR DELETE ON "research_claim_checks"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_verification_mutation"();

DROP TRIGGER IF EXISTS "research_claim_evidence_units_immutable_after_publication"
ON "research_claim_evidence_units";
CREATE TRIGGER "research_claim_evidence_units_immutable_after_publication"
BEFORE INSERT OR UPDATE OR DELETE ON "research_claim_evidence_units"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_verification_mutation"();

CREATE OR REPLACE FUNCTION "protect_embedding_input_format_records"()
RETURNS trigger AS $embedding_input_format_immutability$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Embedding input-format records cannot be deleted.';
  END IF;
  IF OLD."retired_at" IS NULL
    AND NEW."retired_at" IS NOT NULL
    AND OLD."created_at" = NEW."created_at"
    AND OLD."document_template" = NEW."document_template"
    AND OLD."id" = NEW."id"
    AND OLD."input_format_hash" = NEW."input_format_hash"
    AND OLD."name" = NEW."name"
    AND OLD."query_template" = NEW."query_template"
    AND OLD."schema_version" = NEW."schema_version"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Embedding input-format records are immutable except for first retirement.';
END
$embedding_input_format_immutability$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "embedding_input_formats_immutable"
ON "embedding_input_formats";
CREATE TRIGGER "embedding_input_formats_immutable"
BEFORE UPDATE OR DELETE ON "embedding_input_formats"
FOR EACH ROW EXECUTE FUNCTION "protect_embedding_input_format_records"();

DROP TRIGGER IF EXISTS "embedding_input_formats_publish_settings_revision"
ON "embedding_input_formats";
CREATE TRIGGER "embedding_input_formats_publish_settings_revision"
AFTER INSERT OR UPDATE ON "embedding_input_formats"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('settings');

CREATE OR REPLACE FUNCTION "require_active_embedding_space_input_format"()
RETURNS trigger AS $embedding_space_input_format_active$
DECLARE
  input_format_retired_at timestamp with time zone;
BEGIN
  SELECT "retired_at"
  INTO input_format_retired_at
  FROM "embedding_input_formats"
  WHERE "id" = NEW."input_format_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Embedding space input format does not exist.';
  END IF;
  IF input_format_retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'Embedding spaces cannot use a retired input format.';
  END IF;
  RETURN NEW;
END
$embedding_space_input_format_active$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "embedding_spaces_require_active_input_format"
ON "embedding_spaces";
CREATE TRIGGER "embedding_spaces_require_active_input_format"
BEFORE INSERT OR UPDATE OF "input_format_id" ON "embedding_spaces"
FOR EACH ROW
EXECUTE FUNCTION "require_active_embedding_space_input_format"();
