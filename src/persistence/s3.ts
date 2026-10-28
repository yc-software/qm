import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export interface S3Send {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
}

export function s3Client(region?: string): S3Send {
  return new S3Client(region ? { region } : {}) as S3Send;
}

export function bodyToReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body != null && typeof (body as ReadableStream).getReader === "function") {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }
  throw new Error("S3 GetObject returned an unreadable Body");
}

export function isNoSuchKey(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}

export function isNoSuchLifecycleConfiguration(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchLifecycleConfiguration" ||
    e.Code === "NoSuchLifecycleConfiguration" ||
    e.$metadata?.httpStatusCode === 404
  );
}

/** One part of a multipart upload: its body and, for a stream body, its exact length. */
export interface S3Part {
  body: Buffer | Readable;
  length?: number;
}

/**
 * Upload `parts` to one S3 key as a multipart upload: create it, send each part in order, complete it,
 * and abort it if anything fails so no parts are left billed. Callers that fit in one part use PutObject.
 */
export async function s3MultipartUpload(
  client: S3Send,
  bucket: string,
  key: string,
  parts: AsyncIterable<S3Part> | Iterable<S3Part>,
): Promise<void> {
  const created = (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }))) as {
    UploadId?: string;
  };
  if (!created.UploadId) throw new Error(`S3 did not return an upload ID for ${key}`);
  const uploadId = created.UploadId;
  const done: Array<{ ETag: string; PartNumber: number }> = [];
  try {
    for await (const part of parts) {
      const PartNumber = done.length + 1;
      try {
        const sent = (await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber,
            Body: part.body,
            ...(part.length !== undefined ? { ContentLength: part.length } : {}),
          }),
        )) as { ETag?: string };
        if (!sent.ETag) throw new Error(`S3 did not return an ETag for part ${PartNumber} of ${key}`);
        done.push({ ETag: sent.ETag, PartNumber });
      } finally {
        if (part.body instanceof Readable) part.body.destroy();
      }
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: done },
      }),
    );
  } catch (error) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch((abortError: unknown) =>
        console.warn(
          `[s3] leaked S3 multipart parts for ${key} (upload ${uploadId}); abort failed: ${String(abortError)}`,
        ),
      );
    throw error;
  }
}
