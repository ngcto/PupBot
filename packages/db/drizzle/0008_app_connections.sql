CREATE TYPE "public"."app_connection_status" AS ENUM('pending', 'active', 'error');--> statement-breakpoint
CREATE TABLE "app_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"name" text NOT NULL,
	"composio_account_id" text NOT NULL,
	"auth_config_id" text NOT NULL,
	"status" "app_connection_status" DEFAULT 'pending' NOT NULL,
	"status_detail" text,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_app" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "connector" CASCADE;--> statement-breakpoint
DROP TABLE "connector_account" CASCADE;--> statement-breakpoint
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_app" ADD CONSTRAINT "bot_app_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_app" ADD CONSTRAINT "bot_app_connection_id_app_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."app_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_connection_account_idx" ON "app_connection" USING btree ("composio_account_id");--> statement-breakpoint
CREATE INDEX "app_connection_user_idx" ON "app_connection" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "app_connection_workspace_idx" ON "app_connection" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_app_bot_connection_idx" ON "bot_app" USING btree ("bot_id","connection_id");--> statement-breakpoint
CREATE INDEX "bot_app_connection_idx" ON "bot_app" USING btree ("connection_id");