import { createHash, timingSafeEqual } from "node:crypto";

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hashId(parts: readonly string[], len = 16): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, len);
}

export const shortHash = (s: string): string => hashId([s], 6);
