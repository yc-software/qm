import { LRUCache } from "lru-cache";
import { errMessage } from "../../chassis/src/errors.ts";
import { boundTenant } from "../../chassis/src/tenant.ts";

const FRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;

export function createCanonicalResolver(
  lookup: (sub: string) => Promise<string | null>,
): (sub: string) => Promise<{ id: string; stale: boolean } | null> {
  const known = new LRUCache<string, { id: string; at: number }>({ max: 10_000 });
  const inflight = new Map<string, Promise<string | null>>();
  const refresh = (key: string, sub: string): Promise<string | null> => {
    const pending = inflight.get(key);
    if (pending) return pending;
    const started = lookup(sub)
      .catch((error: unknown) => {
        console.warn(`[portal] canonical principal lookup failed: ${errMessage(error)}`);
        return null;
      })
      .then((id) => {
        if (id !== null) known.set(key, { id, at: Date.now() });
        return id;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };
  return async (sub) => {
    const key = JSON.stringify([boundTenant() ?? null, sub]);
    const found = known.get(key);
    const hit = found && Date.now() - found.at < STALE_MS ? found : undefined;
    if (hit && Date.now() - hit.at < FRESH_MS) return { id: hit.id, stale: false };
    const next = refresh(key, sub);
    if (hit) return { id: hit.id, stale: true };
    const id = await next;
    return id === null ? null : { id, stale: false };
  };
}
