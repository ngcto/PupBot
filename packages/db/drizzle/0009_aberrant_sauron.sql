-- Provider rows learn which built-in they are, plus the details a user set and
-- where each came from. Rows saved before the id existed are matched back by
-- base URL, so an endpoint someone already added becomes the built-in instead of
-- staying a copy whose URL the user can turn into something else.
ALTER TABLE "model_endpoint" ADD COLUMN "builtin_id" text;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN "tool_support" boolean;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN "reasoning_capability" boolean;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN "auto_filled_fields" jsonb;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN "model_list_etag" text;
--> statement-breakpoint
UPDATE "model_endpoint" SET "builtin_id" = 'openrouter'
 WHERE "builtin_id" IS NULL AND rtrim(lower("base_url"), '/') = 'https://openrouter.ai/api/v1';--> statement-breakpoint
UPDATE "model_endpoint" SET "builtin_id" = 'opencode-go'
 WHERE "builtin_id" IS NULL AND rtrim(lower("base_url"), '/') = 'https://opencode.ai/inference/go/openai/v1';--> statement-breakpoint
UPDATE "model_endpoint" SET "builtin_id" = 'vercel-ai-gateway'
 WHERE "builtin_id" IS NULL AND rtrim(lower("base_url"), '/') = 'https://ai-gateway.vercel.sh/v1';--> statement-breakpoint
UPDATE "model_endpoint" SET "builtin_id" = 'ollama-cloud'
 WHERE "builtin_id" IS NULL AND rtrim(lower("base_url"), '/') = 'https://ollama.com/v1';
