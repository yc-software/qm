import { hashId } from "./crypto.ts";

export function scopeStorageKey(scopeId: string): string {
  const legacy = scopeId.replace(/[^a-zA-Z0-9_.-]/g, "__");
  const ref = scopeId.slice(scopeId.indexOf(":") + 1);
  return /^[a-zA-Z0-9_.-]+$/.test(ref) ? legacy : `${legacy}--${hashId([scopeId], 12)}`;
}
