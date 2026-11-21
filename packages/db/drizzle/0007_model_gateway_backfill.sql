-- A database that ran the hosting branch before main's model-gateway work landed
-- compares main's 0003-0005 `when` values against a newer recorded row, so the
-- migrator skips all three: usage_event.cost keeps its zero default and stays NOT
-- NULL, model_endpoint never gains its model list, and the endpoint enum keeps a
-- kind the product dropped. Ordering alone cannot repair that, so this migration
-- states the same end state idempotently: where 0003-0005 already ran, every
-- statement is a no-op.
ALTER TABLE "usage_event" ALTER COLUMN "cost" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "usage_event" ALTER COLUMN "cost" DROP NOT NULL;--> statement-breakpoint
UPDATE "usage_event" SET "cost" = NULL WHERE "cost" = 0;--> statement-breakpoint
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
END $$;
