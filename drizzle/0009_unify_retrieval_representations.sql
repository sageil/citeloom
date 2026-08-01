ALTER TABLE "retrieval_chunks" ALTER COLUMN "id" SET DATA TYPE varchar(76);--> statement-breakpoint
ALTER TABLE "retrieval_chunks_1024" ALTER COLUMN "id" SET DATA TYPE varchar(76);--> statement-breakpoint
ALTER TABLE "retrieval_chunks_384" ALTER COLUMN "id" SET DATA TYPE varchar(76);--> statement-breakpoint
ALTER TABLE "retrieval_lexical_chunks" ALTER COLUMN "id" SET DATA TYPE varchar(76);--> statement-breakpoint
ALTER TABLE "retrieval_chunks" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
ALTER TABLE "retrieval_chunks_1024" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
ALTER TABLE "retrieval_chunks_384" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
ALTER TABLE "retrieval_lexical_chunks" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
UPDATE "retrieval_chunks" SET "representation_type" = 'exact-window';--> statement-breakpoint
UPDATE "retrieval_chunks_1024" SET "representation_type" = 'exact-window';--> statement-breakpoint
UPDATE "retrieval_chunks_384" SET "representation_type" = 'exact-window';--> statement-breakpoint
UPDATE "retrieval_lexical_chunks" SET "representation_type" = 'exact-window';--> statement-breakpoint
DO $validate_retrieval_descriptions$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "representation_type" FROM "retrieval_description_chunks"
      UNION ALL
      SELECT "representation_type" FROM "retrieval_description_chunks_1024"
      UNION ALL
      SELECT "representation_type" FROM "retrieval_description_chunks_384"
      UNION ALL
      SELECT "representation_type" FROM "retrieval_description_lexical_chunks"
    ) AS "description"
    WHERE "description"."representation_type" NOT IN (
      'image-description',
      'table-description'
    )
  ) THEN
    RAISE EXCEPTION 'Retrieval description migration found an invalid representation type.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "retrieval_description_chunks" AS "description"
    WHERE "description"."representation_type" = 'table-description'
      AND NOT EXISTS (
        SELECT 1
        FROM "retrieval_chunks" AS "evidence"
        WHERE "evidence"."document_id" = "description"."document_id"
          AND "evidence"."source_file" = "description"."source_file"
          AND "evidence"."embedding_space_id" = "description"."embedding_space_id"
          AND "evidence"."generation_id" = "description"."generation_id"
          AND "evidence"."parent_id" = "description"."parent_id"
      )
    UNION ALL
    SELECT 1
    FROM "retrieval_description_chunks_1024" AS "description"
    WHERE "description"."representation_type" = 'table-description'
      AND NOT EXISTS (
        SELECT 1
        FROM "retrieval_chunks_1024" AS "evidence"
        WHERE "evidence"."document_id" = "description"."document_id"
          AND "evidence"."source_file" = "description"."source_file"
          AND "evidence"."embedding_space_id" = "description"."embedding_space_id"
          AND "evidence"."generation_id" = "description"."generation_id"
          AND "evidence"."parent_id" = "description"."parent_id"
      )
    UNION ALL
    SELECT 1
    FROM "retrieval_description_chunks_384" AS "description"
    WHERE "description"."representation_type" = 'table-description'
      AND NOT EXISTS (
        SELECT 1
        FROM "retrieval_chunks_384" AS "evidence"
        WHERE "evidence"."document_id" = "description"."document_id"
          AND "evidence"."source_file" = "description"."source_file"
          AND "evidence"."embedding_space_id" = "description"."embedding_space_id"
          AND "evidence"."generation_id" = "description"."generation_id"
          AND "evidence"."parent_id" = "description"."parent_id"
      )
    UNION ALL
    SELECT 1
    FROM "retrieval_description_lexical_chunks" AS "description"
    WHERE "description"."representation_type" = 'table-description'
      AND NOT EXISTS (
        SELECT 1
        FROM "retrieval_lexical_chunks" AS "evidence"
        WHERE "evidence"."document_id" = "description"."document_id"
          AND "evidence"."source_file" = "description"."source_file"
          AND "evidence"."embedding_space_id" = "description"."embedding_space_id"
          AND "evidence"."generation_id" = "description"."generation_id"
          AND "evidence"."parent_id" = "description"."parent_id"
      )
  ) THEN
    RAISE EXCEPTION 'Retrieval description migration found table routing text without exact evidence.';
  END IF;
END
$validate_retrieval_descriptions$;--> statement-breakpoint
INSERT INTO "retrieval_chunks" (
  "document_id",
  "embedding_space_id",
  "evidence_content",
  "generation_id",
  "id",
  "kind",
  "next_retrieval_id",
  "page_number",
  "parent_id",
  "previous_retrieval_id",
  "representation_type",
  "source_file",
  "embedding"
)
SELECT
  "document_id",
  "embedding_space_id",
  "description",
  "generation_id",
  "id",
  "kind",
  NULL,
  NULL,
  "parent_id",
  NULL,
  "representation_type",
  "source_file",
  "embedding"
FROM "retrieval_description_chunks";--> statement-breakpoint
INSERT INTO "retrieval_chunks_1024" (
  "document_id",
  "embedding_space_id",
  "evidence_content",
  "generation_id",
  "id",
  "kind",
  "next_retrieval_id",
  "page_number",
  "parent_id",
  "previous_retrieval_id",
  "representation_type",
  "source_file",
  "embedding"
)
SELECT
  "document_id",
  "embedding_space_id",
  "description",
  "generation_id",
  "id",
  "kind",
  NULL,
  NULL,
  "parent_id",
  NULL,
  "representation_type",
  "source_file",
  "embedding"
FROM "retrieval_description_chunks_1024";--> statement-breakpoint
INSERT INTO "retrieval_chunks_384" (
  "document_id",
  "embedding_space_id",
  "evidence_content",
  "generation_id",
  "id",
  "kind",
  "next_retrieval_id",
  "page_number",
  "parent_id",
  "previous_retrieval_id",
  "representation_type",
  "source_file",
  "embedding"
)
SELECT
  "document_id",
  "embedding_space_id",
  "description",
  "generation_id",
  "id",
  "kind",
  NULL,
  NULL,
  "parent_id",
  NULL,
  "representation_type",
  "source_file",
  "embedding"
FROM "retrieval_description_chunks_384";--> statement-breakpoint
INSERT INTO "retrieval_lexical_chunks" (
  "content",
  "document_id",
  "embedding_space_id",
  "evidence_content",
  "generation_id",
  "id",
  "kind",
  "next_retrieval_id",
  "page_number",
  "parent_id",
  "previous_retrieval_id",
  "representation_type",
  "source_file"
)
SELECT
  "content",
  "document_id",
  "embedding_space_id",
  "description",
  "generation_id",
  "id",
  "kind",
  NULL,
  NULL,
  "parent_id",
  NULL,
  "representation_type",
  "source_file"
FROM "retrieval_description_lexical_chunks";--> statement-breakpoint
ALTER TABLE "retrieval_chunks" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_chunks_1024" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_chunks_384" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_lexical_chunks" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks_1024" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks_384" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retrieval_description_lexical_chunks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "retrieval_description_chunks_1024" CASCADE;--> statement-breakpoint
DROP TABLE "retrieval_description_chunks_384" CASCADE;--> statement-breakpoint
DROP TABLE "retrieval_description_chunks" CASCADE;--> statement-breakpoint
DROP TABLE "retrieval_description_lexical_chunks" CASCADE;
