import { createHash } from "node:crypto";
import { swallowAs } from "./errors.ts";

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;

export async function* asChunks(source: ByteSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  yield* source;
}

export interface CollectedBytes {
  data: Buffer;
  sizeBytes: number;
  sha256: string;
}

export async function collectBytes(
  source: ByteSource,
  opts?: { maxBytes?: number; tooLarge?: () => Error },
): Promise<CollectedBytes> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of asChunks(source)) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (opts?.maxBytes != null && size > opts.maxBytes) {
      throw opts.tooLarge ? opts.tooLarge() : new Error("byte source exceeds the size limit");
    }
    hash.update(buf);
    chunks.push(buf);
  }
  return { data: Buffer.concat(chunks), sizeBytes: size, sha256: hash.digest("hex") };
}

export function boundedResponse(response: Response, maxBytes: number, tooLarge: () => Error): Response {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(swallowAs("bounded response cancel", undefined));
    throw tooLarge();
  }
  if (!response.body) return response;
  let size = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function readBoundedText(response: Response, maxBytes: number, tooLarge: () => Error): Promise<string> {
  return boundedResponse(response, maxBytes, tooLarge).text();
}
