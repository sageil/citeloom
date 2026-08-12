ALTER TABLE "source_libraries" DROP CONSTRAINT "source_libraries_name_check";--> statement-breakpoint
ALTER TABLE "source_libraries" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
UPDATE "source_libraries" SET "name" = NULL WHERE "kind" = 'private';--> statement-breakpoint
ALTER TABLE "source_libraries" ADD CONSTRAINT "source_libraries_name_check" CHECK (("source_libraries"."kind" = 'private' AND "source_libraries"."name" IS NULL)
        OR ("source_libraries"."kind" = 'shared' AND "source_libraries"."name" IS NOT NULL
          AND length(trim("source_libraries"."name")) > 0));
