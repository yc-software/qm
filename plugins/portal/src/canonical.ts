import { LRUCache } from "lru-cache";
import { errMessage } from "../../chassis/src/errors.ts";

const FRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;

export class IdentityRejected extends Error {}

export function createCanonicalResolver(
  lookup: (sub: string, tenant?: string) => Promise<string | null>,
): (sub: string, tenant?: string) => Promise<{ id: string; stale: boolean } | "rejected" | null> {
  const known = new LRUCache<string, { id: string; at: number }>({ max: 10_000 });
  const inflight = new Map<string, Promise<string | null | "rejected">>();
  const refresh = (key: string, sub: string, tenant?: string): Promise<string | null | "rejected"> => {
    const pending = inflight.get(key);
    if (pending) return pending;
    const started = lookup(sub, tenant)
      .catch((error: unknown): null | "rejected" => {
        if (error instanceof IdentityRejected) {
          known.delete(key);
          return "rejected";
        }
        console.warn(`[portal] canonical principal lookup failed: ${errMessage(error)}`);
        return null;
      })
      .then((id) => {
        if (id !== null && id !== "rejected") known.set(key, { id, at: Date.now() });
        return id;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };
  return async (sub, tenant) => {
    const key = `${tenant ?? ""}|${sub}`;
    const found = known.get(key);
    const hit = found && Date.now() - found.at < STALE_MS ? found : undefined;
    if (hit && Date.now() - hit.at < FRESH_MS) return { id: hit.id, stale: false };
    const next = refresh(key, sub, tenant);
    if (hit) return { id: hit.id, stale: true };
    const id = await next;
    return id === null || id === "rejected" ? id : { id, stale: false };
  };
}
