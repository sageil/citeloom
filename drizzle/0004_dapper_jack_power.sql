DROP INDEX "research_statements_turn_index_idx";--> statement-breakpoint
ALTER TABLE "research_statements" ADD COLUMN "review_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks_1024" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks_384" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
ALTER TABLE "retrieval_description_lexical_chunks" ADD COLUMN "representation_type" varchar(32);--> statement-breakpoint
UPDATE "retrieval_description_chunks_1024" SET "representation_type" = CASE WHEN "kind" = 'image' THEN 'image-description' ELSE 'table-description' END;--> statement-breakpoint
UPDATE "retrieval_description_chunks_384" SET "representation_type" = CASE WHEN "kind" = 'image' THEN 'image-description' ELSE 'table-description' END;--> statement-breakpoint
UPDATE "retrieval_description_chunks" SET "representation_type" = CASE WHEN "kind" = 'image' THEN 'image-description' ELSE 'table-description' END;--> statement-breakpoint
UPDATE "retrieval_description_lexical_chunks" SET "representation_type" = CASE WHEN "kind" = 'image' THEN 'image-description' ELSE 'table-description' END;--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks_1024" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks_384" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_description_chunks" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retrieval_description_lexical_chunks" ALTER COLUMN "representation_type" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "research_statements_turn_disposition_index_idx" ON "research_statements" USING btree ("turn_id","review_required","statement_index");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_research_turn_output"("target_turn_id" uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  "citation_count" bigint;
  "citation_max" integer;
  "citation_min" integer;
  "link_count" bigint;
  "statement_count" bigint;
BEGIN
  SELECT count(*), min("citation_number"), max("citation_number")
  INTO "citation_count", "citation_min", "citation_max"
  FROM "citation_records"
  WHERE "turn_id" = "target_turn_id";

  SELECT count(*)
  INTO "statement_count"
  FROM "research_statements"
  WHERE "turn_id" = "target_turn_id";

  SELECT count(*)
  INTO "link_count"
  FROM "research_statement_citations"
  WHERE "turn_id" = "target_turn_id";

  IF "citation_count" = 0 AND "statement_count" = 0 AND "link_count" = 0 THEN
    RETURN;
  END IF;

  IF "citation_count" = 0 OR "statement_count" = 0 OR "link_count" = 0 THEN
    RAISE EXCEPTION 'Research turn % has incomplete published output.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF "citation_min" <> 1 OR "citation_max" <> "citation_count" THEN
    RAISE EXCEPTION 'Research turn % has non-contiguous citation numbers.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "research_statements"
    WHERE "turn_id" = "target_turn_id"
    GROUP BY "review_required"
    HAVING min("statement_index") <> 0
      OR max("statement_index") <> count(*) - 1
  ) THEN
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
    HAVING min("citation_position") <> 0
      OR max("citation_position") <> count(*) - 1
  ) THEN
    RAISE EXCEPTION 'Research turn % has non-contiguous statement citation positions.', "target_turn_id"
      USING ERRCODE = '23514';
  END IF;
END;
$$;
