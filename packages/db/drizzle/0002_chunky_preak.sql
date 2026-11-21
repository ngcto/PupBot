CREATE TABLE "attachment_blob" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_blob" ADD CONSTRAINT "attachment_blob_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE cascade ON UPDATE no action;