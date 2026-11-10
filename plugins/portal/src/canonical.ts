import { LRUCache } from "lru-cache";
import { errMessage } from "../../chassis/src/errors.ts";

const FRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;

export class IdentityRejected extends Error {}

export interface CanonicalPerson {
  id: string;
  name?: string;
  stored?: true;
}

export function createCanonicalResolver(
  lookup: (sub: string, tenant?: string) => Promise<string | CanonicalPerson | null>,
): (sub: string, tenant?: string) => Promise<(CanonicalPerson & { stale: boolean }) | IdentityRejected | null> {
  const known = new LRUCache<string, CanonicalPerson & { at: number }>({ max: 10_000 });
  const inflight = new Map<string, Promise<CanonicalPerson | null | IdentityRejected>>();
  const refresh = (key: string, sub: string, tenant?: string): Promise<CanonicalPerson | null | IdentityRejected> => {
    const pending = inflight.get(key);
    if (pending) return pending;
    const started = lookup(sub, tenant)
      .catch((error: unknown): null | IdentityRejected => {
        if (error instanceof IdentityRejected) {
          known.delete(key);
          return error;
        }
        console.warn(`[portal] canonical principal lookup failed: ${errMessage(error)}`);
        return null;
      })
      .then((found) => {
        const person = typeof found === "string" ? { id: found } : found;
        if (person && !(person instanceof IdentityRejected)) known.set(key, { ...person, at: Date.now() });
        return person;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };
  return async (sub, tenant) => {
    const key = `${tenant ?? ""}|${sub}`;
    const found = known.get(key);
    const hit = found && Date.now() - found.at < STALE_MS ? found : undefined;
    const answer = ({ id, name, stored }: CanonicalPerson, stale: boolean) => ({
      id,
      ...(name ? { name } : {}),
      ...(stored ? { stored } : {}),
      stale,
    });
    if (hit && Date.now() - hit.at < FRESH_MS) return answer(hit, false);
    const person = await refresh(key, sub, tenant);
    if (person === null && hit) return answer(hit, true);
    return person === null || person instanceof IdentityRejected ? person : answer(person, false);
  };
}
