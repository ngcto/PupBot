ALTER TYPE "public"."computer_status" ADD VALUE 'waking' BEFORE 'error';--> statement-breakpoint
CREATE TABLE "computer_lease" (
	"id" text PRIMARY KEY NOT NULL,
	"computer_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot" ADD COLUMN "computer_state" text DEFAULT 'unbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot" ADD COLUMN "computer_reason" text;--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "computer_account" ADD COLUMN "parked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computer_account" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "computer_lease" ADD CONSTRAINT "computer_lease_computer_id_computer_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_lease_computer_idx" ON "computer_lease" USING btree ("computer_id","expires_at");