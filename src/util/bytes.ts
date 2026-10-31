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

export async function readBoundedText(response: Response, maxBytes: number, tooLarge: () => Error): Promise<string> {
  const cancel = () => void response.body?.cancel().catch(swallowAs("bounded response cancel", undefined));
  if (Number(response.headers.get("content-length")) > maxBytes) {
    cancel();
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(Buffer.concat(chunks, size));
    size += value.byteLength;
    if (size > maxBytes) {
      void reader.cancel().catch(swallowAs("bounded response cancel", undefined));
      throw tooLarge();
    }
    chunks.push(value);
  }
}
