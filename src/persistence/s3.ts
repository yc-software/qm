import { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export interface S3Send {
  send(command: unknown): Promise<unknown>;
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
