ALTER TABLE "research_turns" ADD COLUMN "no_answer_content" text;--> statement-breakpoint
ALTER TABLE "research_turns" DISABLE TRIGGER "research_turns_publish";--> statement-breakpoint
ALTER TABLE "research_turns" DISABLE TRIGGER "research_turns_require_published";--> statement-breakpoint
UPDATE "research_turns"
SET "no_answer_content" = 'I couldn''t find the answer to your question in the available information.'
WHERE NOT EXISTS (
  SELECT 1
  FROM "research_statements"
  WHERE "research_statements"."turn_id" = "research_turns"."id"
);--> statement-breakpoint
ALTER TABLE "research_turns" ENABLE TRIGGER "research_turns_require_published";--> statement-breakpoint
ALTER TABLE "research_turns" ENABLE TRIGGER "research_turns_publish";--> statement-breakpoint
ALTER TABLE "research_turns" ADD CONSTRAINT "research_turns_no_answer_content_check" CHECK ("research_turns"."no_answer_content" IS NULL OR length(trim("research_turns"."no_answer_content")) > 0);--> statement-breakpoint
UPDATE "chat_messages"
SET "answer_document" = "answer_document" - 'status'
WHERE "answer_document" ? 'status';
