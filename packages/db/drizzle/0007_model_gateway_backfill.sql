-- A database that ran the hosting branch before main's model-gateway work landed
-- compares main's 0003-0005 `when` values against a newer recorded row, so the
-- migrator skips all three: usage_event.cost keeps its zero default and stays NOT
-- NULL, model_endpoint never gains its model list, and the endpoint enum keeps a
-- kind the product dropped. The same skip hides 0002_huge_captain_flint, whose
-- computer objects the hosting history never carried at all. Ordering alone cannot
-- repair either, so this migration states both end states idempotently: where the
-- skipped entries already ran, every statement is a no-op.
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'usage_event' AND column_name = 'cost' AND column_default IS NOT NULL
 ) THEN
  ALTER TABLE "usage_event" ALTER COLUMN "cost" DROP DEFAULT;
  ALTER TABLE "usage_event" ALTER COLUMN "cost" DROP NOT NULL;
  UPDATE "usage_event" SET "cost" = NULL WHERE "cost" = 0;
 END IF;
END $$;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN IF NOT EXISTS "model_list" jsonb;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN IF NOT EXISTS "model_list_fetched_at" timestamp with time zone;--> statement-breakpoint
DELETE FROM "model_endpoint" WHERE "kind"::text = 'chatgpt-oauth';--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'endpoint_kind' AND e.enumlabel = 'chatgpt-oauth'
 ) THEN
  ALTER TABLE "model_endpoint" ALTER COLUMN "kind" SET DATA TYPE text;
  DROP TYPE "public"."endpoint_kind";
  CREATE TYPE "public"."endpoint_kind" AS ENUM('openai-chat', 'openai-responses', 'anthropic-messages');
  ALTER TABLE "model_endpoint" ALTER COLUMN "kind" SET DATA TYPE "public"."endpoint_kind" USING "kind"::"public"."endpoint_kind";
 END IF;
END $$;--> statement-breakpoint
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
