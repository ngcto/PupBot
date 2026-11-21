ALTER TABLE "usage_event" ALTER COLUMN "cost" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "usage_event" ALTER COLUMN "cost" DROP NOT NULL;--> statement-breakpoint
UPDATE "usage_event" SET "cost" = NULL WHERE "cost" = 0;
