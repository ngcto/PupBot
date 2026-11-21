CREATE TABLE "attachment_blob" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "attachment_blob" ADD CONSTRAINT "attachment_blob_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_workspace_idx" ON "attachment" USING btree ("workspace_id");