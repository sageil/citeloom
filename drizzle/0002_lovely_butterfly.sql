CREATE TYPE "public"."chat_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."chat_run_state" AS ENUM('accepted', 'embedding', 'retrieving', 'generating', 'verifying', 'publishing', 'completed', 'failed', 'canceled');--> statement-breakpoint
ALTER TYPE "public"."telemetry_run_kind" ADD VALUE 'chat' BEFORE 'retrieval';--> statement-breakpoint
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
ALTER TABLE "chat_citation_records" ADD CONSTRAINT "chat_citation_records_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_citation_records" ADD CONSTRAINT "chat_citation_records_document_version_id_chat_evidence_documents_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."chat_evidence_documents"("document_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_owner_membership_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_evidence_documents" ADD CONSTRAINT "chat_evidence_documents_document_id_source_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_1024" ADD CONSTRAINT "chat_message_embeddings_1024_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_1024" ADD CONSTRAINT "chat_message_embeddings_1024_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_384" ADD CONSTRAINT "chat_message_embeddings_384_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_384" ADD CONSTRAINT "chat_message_embeddings_384_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_768" ADD CONSTRAINT "chat_message_embeddings_768_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_embeddings_768" ADD CONSTRAINT "chat_message_embeddings_768_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_citation_records_message_number_idx" ON "chat_citation_records" USING btree ("assistant_message_id","citation_number");--> statement-breakpoint
CREATE INDEX "chat_citation_records_version_idx" ON "chat_citation_records" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "chat_conversations_owner_updated_idx" ON "chat_conversations" USING btree ("workspace_id","owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_evidence_documents_document_idx" ON "chat_evidence_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_1024_message_idx" ON "chat_message_embeddings_1024" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_1024_hnsw_idx" ON "chat_message_embeddings_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_384_message_idx" ON "chat_message_embeddings_384" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_384_hnsw_idx" ON "chat_message_embeddings_384" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_768_message_idx" ON "chat_message_embeddings_768" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_message_embeddings_768_hnsw_idx" ON "chat_message_embeddings_768" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_run_role_idx" ON "chat_messages" USING btree ("run_id","role");--> statement-breakpoint
CREATE INDEX "chat_messages_run_created_idx" ON "chat_messages" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_runs_conversation_sequence_idx" ON "chat_runs" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "chat_runs_conversation_state_idx" ON "chat_runs" USING btree ("conversation_id","state");