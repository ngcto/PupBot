import { serverEnv } from "@pupbot/config";
import type { ServerEnv } from "@pupbot/config";
import { createPostgresStore } from "./postgres.ts";
import { createS3Store } from "./s3.ts";

/** Attachments are opaque bytes at a key; the row keeps name, size and mime. */
export interface AttachmentStore {
  readonly driver: "s3" | "postgres";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

/**
 * S3 wins when the whole contract is set (Supabase Storage, MinIO, AWS), so a
 * deployment moves to it by adding environment variables and nothing else.
 * Otherwise bytes live in Postgres, which needs no second credential.
 */
export function createAttachmentStore(env: ServerEnv = serverEnv()): AttachmentStore {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY) {
    return createS3Store({
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    });
  }
  return createPostgresStore();
}

let shared: AttachmentStore | undefined;

export function attachmentStore(): AttachmentStore {
  if (!shared) shared = createAttachmentStore();
  return shared;
}

export function resetAttachmentStore(): void {
  shared = undefined;
}

export { createPostgresStore, createS3Store };
