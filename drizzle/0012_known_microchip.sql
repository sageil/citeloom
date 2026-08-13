ALTER TYPE "public"."authentication_configuration_event_type" ADD VALUE 'host_recovery_enabled' BEFORE 'recovered';--> statement-breakpoint
ALTER TYPE "public"."authentication_configuration_event_type" ADD VALUE 'host_recovery_disabled' BEFORE 'recovered';--> statement-breakpoint
ALTER TABLE "authentication_settings" ADD COLUMN "host_recovery_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "authentication_settings" SET "host_recovery_enabled" = true WHERE "mode" = 'oauth';--> statement-breakpoint
ALTER TABLE "authentication_settings" ADD CONSTRAINT "authentication_settings_oauth_recovery_check" CHECK ("authentication_settings"."mode" <> 'oauth' OR "authentication_settings"."host_recovery_enabled");
