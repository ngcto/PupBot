-- Managed computer accounts: the deployment provides account rows so a new user
-- gets a working computer with no configuration, and a user's own account stays
-- distinguishable from one the deployment supplied.
--
-- `managed` is false for every existing row, so a deployment that already had a
-- user-connected key behaves exactly as it did: nothing is promoted to managed
-- behind anyone's back. `owner_user_id` stays null on those rows because the
-- table never recorded who added them, and both uniqueness rules skip nulls.
--
-- Written idempotently, like 0007: the hosting history skipped 0002 once and a
-- repeated statement is cheaper than a deploy that cannot migrate.
ALTER TABLE "computer_account" ADD COLUMN IF NOT EXISTS "managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_account" ADD COLUMN IF NOT EXISTS "owner_user_id" text;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE conname = 'computer_account_owner_user_id_user_id_fk'
 ) THEN
  ALTER TABLE "computer_account"
   ADD CONSTRAINT "computer_account_owner_user_id_user_id_fk"
   FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
-- One account per provider per user. Managed rows are exempt (owner null), and
-- a user may still connect several different providers.
CREATE UNIQUE INDEX IF NOT EXISTS "computer_account_owner_provider_idx"
 ON "computer_account" USING btree ("owner_user_id","provider")
 WHERE "computer_account"."owner_user_id" is not null;--> statement-breakpoint
-- One deployment-provided account per provider for the whole deployment.
CREATE UNIQUE INDEX IF NOT EXISTS "computer_account_managed_provider_idx"
 ON "computer_account" USING btree ("provider") WHERE "computer_account"."managed";
