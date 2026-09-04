import { createHash } from "node:crypto";

export function scopeStorageKey(scopeId: string): string {
  const legacy = scopeId.replace(/[^a-zA-Z0-9_.-]/g, "__");
  const ref = scopeId.slice(scopeId.indexOf(":") + 1);
  if (/^[a-zA-Z0-9_.-]+$/.test(ref)) return legacy;
  const hash = createHash("sha256").update(scopeId).digest("hex").slice(0, 12);
  return `${legacy}--${hash}`;
}
