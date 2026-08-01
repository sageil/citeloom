ALTER TABLE "research_statement_citations" DISABLE TRIGGER "research_statement_citations_immutable_after_publication";--> statement-breakpoint
ALTER TABLE "research_statements" DISABLE TRIGGER "research_statements_immutable_after_publication";--> statement-breakpoint
ALTER TABLE "citation_records" DISABLE TRIGGER "citation_records_immutable_after_publication";--> statement-breakpoint
DELETE FROM "research_statement_citations" AS "link"
USING "research_statements" AS "statement"
WHERE "link"."turn_id" = "statement"."turn_id"
  AND "link"."statement_id" = "statement"."id"
  AND "statement"."review_required" = true;--> statement-breakpoint
DELETE FROM "citation_records" AS "citation"
WHERE EXISTS (
    SELECT 1
    FROM "research_statements" AS "statement"
    WHERE "statement"."turn_id" = "citation"."turn_id"
      AND "statement"."review_required" = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "research_statement_citations" AS "link"
    WHERE "link"."turn_id" = "citation"."turn_id"
      AND "link"."citation_id" = "citation"."id"
  );--> statement-breakpoint
DELETE FROM "research_statements"
WHERE "review_required" = true;--> statement-breakpoint
ALTER TABLE "research_statement_citations" ENABLE TRIGGER "research_statement_citations_immutable_after_publication";--> statement-breakpoint
ALTER TABLE "research_statements" ENABLE TRIGGER "research_statements_immutable_after_publication";--> statement-breakpoint
ALTER TABLE "citation_records" ENABLE TRIGGER "citation_records_immutable_after_publication";--> statement-breakpoint
DROP INDEX "research_statements_turn_disposition_index_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "research_statements_turn_index_idx" ON "research_statements" USING btree ("turn_id","statement_index");--> statement-breakpoint
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
  "statement_max" integer;
  "statement_min" integer;
BEGIN
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
END;
$$;--> statement-breakpoint
ALTER TABLE "research_statements" DROP COLUMN "review_required";
