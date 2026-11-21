import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AttachmentStore } from "./index.ts";

export interface S3StoreOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/**
 * Any S3-compatible bucket. Supabase Storage speaks this protocol at
 * `<project>.storage.supabase.co/storage/v1/s3`; path-style addressing is what
 * it expects, so forcePathStyle is on.
 */
export function createS3Store(options: S3StoreOptions): AttachmentStore {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region ?? "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    driver: "s3",
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async read(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
        const bytes = await result.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
  };
}
