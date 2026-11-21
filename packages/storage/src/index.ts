import { serverEnv } from "@terabot/config";
import type { ServerEnv } from "@terabot/config";
import { createPostgresStore } from "./postgres.ts";
import { createS3Store } from "./s3.ts";

export type AttachmentDriver = "s3" | "postgres";

/** The key names a backend this deployment no longer has credentials for. */
export class StorageBackendUnavailable extends Error {}

/** Attachments are opaque bytes at a key; the row keeps name, size and mime. */
export interface AttachmentStore {
  readonly driver: AttachmentDriver;
  /** The key is the attachment id; the driver decides where those bytes live. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

/**
 * The row's storage key names the backend that holds the bytes, so turning S3
 * on later moves new uploads there without stranding the ones already written
 * to Postgres — reads still find the old driver. Keys written before this
 * prefix existed are bare ids and were always Postgres rows.
 */
export function storageKeyFor(driver: AttachmentDriver, id: string): string {
  return `${driver === "s3" ? "s3" : "pg"}:${id}`;
}

function driverForKey(storageKey: string): AttachmentDriver {
  return storageKey.startsWith("s3:") ? "s3" : "postgres";
}

function bareKey(storageKey: string): string {
  return storageKey.replace(/^(s3|pg):/, "");
}

interface S3Settings {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function s3Settings(env: ServerEnv): S3Settings | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) return null;
  return {
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  };
}

/**
 * S3 is the writer when the whole contract is set (Supabase Storage, MinIO,
 * AWS), so a deployment moves to it by adding environment variables. Reads
 * follow the key, so both backends keep answering while the backend each row
 * was written to is still configured.
 * Without S3 configured everything lives in Postgres, which needs no second
 * credential.
 */
export function createAttachmentStore(env: ServerEnv = serverEnv()): AttachmentStore {
  const settings = s3Settings(env);
  const writer = settings ? createS3Store(settings) : createPostgresStore();

  const storeFor = (driver: AttachmentDriver): AttachmentStore | null => {
    if (driver === "s3") return settings ? createS3Store(settings) : null;
    return createPostgresStore();
  };

  return {
    driver: writer.driver,
    async put(key, body, contentType) {
      await writer.put(key, body, contentType);
    },
    async read(storageKey) {
      const store = storeFor(driverForKey(storageKey));
      // A missing backend is a configuration fault, not a missing file: the
      // bytes still exist, so say so instead of answering not_found.
      if (!store) throw new StorageBackendUnavailable(driverForKey(storageKey));
      return store.read(bareKey(storageKey));
    },
    async remove(storageKey) {
      const store = storeFor(driverForKey(storageKey));
      if (!store) throw new StorageBackendUnavailable(driverForKey(storageKey));
      await store.remove(bareKey(storageKey));
    },
  };
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
