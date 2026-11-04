import type { Readable } from "node:stream";

export async function readTextPrefix(
  stream: Readable,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buffer.length >= maxBytes) {
      chunks.push(buffer.subarray(0, maxBytes - total));
      truncated = true;
      stream.destroy();
      break;
    }
    chunks.push(buffer);
    total += buffer.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
