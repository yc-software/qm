import { createHash } from "node:crypto";

export function hashId(parts: readonly string[], len = 16): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, len);
}

export const shortHash = (s: string): string => hashId([s], 6);
