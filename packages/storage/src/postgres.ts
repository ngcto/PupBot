import { attachmentBlob, database } from "@terabot/db";
import { eq } from "drizzle-orm";
import type { AttachmentStore } from "./index.ts";

/**
 * No object store configured: bytes live in Postgres next to the row that
 * names them. Row-scoped, transactional, and small enough for chat files.
 */
export function createPostgresStore(): AttachmentStore {
  return {
    driver: "postgres",
    async put(key, body) {
      await database()
        .insert(attachmentBlob)
        .values({ attachmentId: key, bytes: body })
        .onConflictDoUpdate({ target: attachmentBlob.attachmentId, set: { bytes: body } });
    },
    async read(key) {
      const rows = await database()
        .select({ bytes: attachmentBlob.bytes })
        .from(attachmentBlob)
        .where(eq(attachmentBlob.attachmentId, key))
        .limit(1);
      return rows[0]?.bytes ?? null;
    },
    async remove(key) {
      await database().delete(attachmentBlob).where(eq(attachmentBlob.attachmentId, key));
    },
  };
}
