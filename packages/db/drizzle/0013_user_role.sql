CREATE TYPE "public"."user_role" AS ENUM('owner', 'member');--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" "user_role" DEFAULT 'member' NOT NULL;