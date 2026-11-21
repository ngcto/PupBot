CREATE TABLE "computer_orphan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"reason" text NOT NULL,
	"bot_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computer_account" DROP CONSTRAINT "computer_account_owner_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "computer_orphan" ADD CONSTRAINT "computer_orphan_account_id_computer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."computer_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_orphan_provider_idx" ON "computer_orphan" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "computer_orphan_attempt_idx" ON "computer_orphan" USING btree ("last_attempt_at");--> statement-breakpoint
ALTER TABLE "computer" ADD CONSTRAINT "computer_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_account" ADD CONSTRAINT "computer_account_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_workspace_idx" ON "computer" USING btree ("workspace_id");--> statement-breakpoint
-- Backfill: a box belongs to the workspace of the bot that owns it. `bot_computer`
-- is the only link that exists right now, and a box whose bot is already gone keeps
-- a null workspace — the reconcile sweep destroys those by bot id anyway.
UPDATE "computer" c
SET "workspace_id" = b."workspace_id"
FROM "bot_computer" bc
JOIN "bot" b ON b."id" = bc."bot_id"
WHERE bc."computer_id" = c."id" AND bc."released_at" IS NULL AND c."workspace_id" IS NULL;
