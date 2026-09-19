import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  type AbortMultipartUploadCommandInput,
} from "@aws-sdk/client-s3";
import { addAbortSignal, Readable } from "node:stream";
import { getOperationSignal, withCleanupSignal } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";

export interface S3Send {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export async function abortS3MultipartUpload(client: S3Send, input: AbortMultipartUploadCommandInput): Promise<void> {
  await withCleanupSignal(1_000, () =>
    client.send(new AbortMultipartUploadCommand(input), { abortSignal: getOperationSignal() }),
  );
}

export function s3Client(region?: string, client: S3Send = new S3Client(region ? { region } : {})): S3Send {
  return {
    async send(command, options) {
      const parent = getOperationSignal();
      const explicit = options?.abortSignal;
      const signal =
        parent && explicit && parent !== explicit ? AbortSignal.any([parent, explicit]) : (explicit ?? parent);
      signal?.throwIfAborted();
      const result = await client.send(command, { ...options, abortSignal: signal });
      if (
        signal?.aborted &&
        command instanceof CreateMultipartUploadCommand &&
        result &&
        typeof result === "object" &&
        "UploadId" in result &&
        typeof result.UploadId === "string" &&
        result.UploadId
      ) {
        await abortS3MultipartUpload(client, {
          Bucket: command.input.Bucket,
          Key: command.input.Key,
          UploadId: result.UploadId,
        }).catch(swallowAs("s3: abort upload after cancelled creation", undefined));
      }
      if (signal && result && typeof result === "object" && "Body" in result && result.Body instanceof Readable) {
        if (signal.aborted) result.Body.destroy();
        else addAbortSignal(signal, result.Body);
      }
      signal?.throwIfAborted();
      return result;
    },
  };
}

export function bodyToReadable(body: unknown): Readable {
  let stream: Readable;
  if (body instanceof Readable) stream = body;
  else if (body != null && typeof (body as ReadableStream).getReader === "function") {
    stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  } else throw new Error("S3 GetObject returned an unreadable Body");
  const signal = getOperationSignal();
  return signal ? addAbortSignal(signal, stream) : stream;
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
