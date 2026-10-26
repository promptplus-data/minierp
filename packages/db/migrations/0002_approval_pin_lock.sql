ALTER TABLE "users" ADD COLUMN "pin_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pin_locked_until" timestamp with time zone;