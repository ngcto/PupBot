CREATE TYPE "public"."billing_status" AS ENUM('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'revoked', 'paused');--> statement-breakpoint
CREATE TABLE "billing_subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" "billing_status" DEFAULT 'incomplete' NOT NULL,
	"polar_customer_id" text,
	"polar_subscription_id" text,
	"polar_checkout_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"last_event_id" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_subscription" ADD CONSTRAINT "billing_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_user_idx" ON "billing_subscription" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "billing_subscription_polar_sub_idx" ON "billing_subscription" USING btree ("polar_subscription_id");--> statement-breakpoint
CREATE INDEX "billing_subscription_customer_idx" ON "billing_subscription" USING btree ("polar_customer_id");