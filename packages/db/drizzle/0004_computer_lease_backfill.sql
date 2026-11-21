-- The merge that brought main's hosting work together renumbered the migration
-- history, so a database that had already applied the hosting branch's
-- attachment migrations jumps straight past `0002_huge_captain_flint` (its
-- `when` is older than the newest recorded row) and never gets the computer
-- lease objects. Drizzle's migrator compares the newest applied `created_at`
-- against each entry's `when`, so ordering alone cannot repair that history.
-- This migration states the same objects idempotently instead: on a database
-- that already ran 0002 every statement is a no-op, and on one that skipped it
-- the schema is completed.
ALTER TYPE "public"."computer_status" ADD VALUE IF NOT EXISTS 'waking' BEFORE 'error';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "computer_lease" (
	"id" text PRIMARY KEY NOT NULL,
	"computer_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot" ADD COLUMN IF NOT EXISTS "computer_state" text DEFAULT 'unbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot" ADD COLUMN IF NOT EXISTS "computer_reason" text;--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN IF NOT EXISTS "last_error_code" text;--> statement-breakpoint
ALTER TABLE "computer_account" ADD COLUMN IF NOT EXISTS "parked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computer_account" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "computer_lease" ADD CONSTRAINT "computer_lease_computer_id_computer_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "computer_lease_computer_idx" ON "computer_lease" USING btree ("computer_id","expires_at");
