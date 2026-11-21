-- The ChatGPT subscription endpoint kind is gone from the product; any row
-- that still carries it could never run, so it goes before the enum swap.
DELETE FROM "model_endpoint" WHERE "kind" = 'chatgpt-oauth';--> statement-breakpoint
ALTER TABLE "model_endpoint" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."endpoint_kind";--> statement-breakpoint
CREATE TYPE "public"."endpoint_kind" AS ENUM('openai-chat', 'openai-responses', 'anthropic-messages');--> statement-breakpoint
ALTER TABLE "model_endpoint" ALTER COLUMN "kind" SET DATA TYPE "public"."endpoint_kind" USING "kind"::"public"."endpoint_kind";