ALTER TABLE "model_endpoint" ADD COLUMN "model_list" jsonb;--> statement-breakpoint
ALTER TABLE "model_endpoint" ADD COLUMN "model_list_fetched_at" timestamp with time zone;