CREATE TYPE "public"."secret_request_status" AS ENUM('pending', 'provided', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."vault_item_kind" AS ENUM('login', 'card', 'contact');--> statement-breakpoint
CREATE TABLE "secret_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"kind" "vault_item_kind" NOT NULL,
	"reason" text NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "secret_request_status" DEFAULT 'pending' NOT NULL,
	"vault_item_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" "vault_item_kind" NOT NULL,
	"label" text NOT NULL,
	"domain" text,
	"hint" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secret_request" ADD CONSTRAINT "secret_request_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_request" ADD CONSTRAINT "secret_request_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_request" ADD CONSTRAINT "secret_request_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_request" ADD CONSTRAINT "secret_request_bot_id_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_request" ADD CONSTRAINT "secret_request_vault_item_id_vault_item_id_fk" FOREIGN KEY ("vault_item_id") REFERENCES "public"."vault_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_item" ADD CONSTRAINT "vault_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_item" ADD CONSTRAINT "vault_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_request_run_idx" ON "secret_request" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "secret_request_pending_idx" ON "secret_request" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "vault_item_workspace_idx" ON "vault_item" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "vault_item_owner_idx" ON "vault_item" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vault_item_domain_idx" ON "vault_item" USING btree ("workspace_id","domain");