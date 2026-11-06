import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { errMessage } from "../../chassis/src/errors.ts";

const BACKFILL_TTL_MS = 10 * 60_000;

export function createSignedInNames(deps: {
  core: string;
  signingSecret: string | undefined;
  identityHeaders: (sub: string, tenant?: string) => Record<string, string>;
  timeoutMs: number;
}) {
  const backfilled = new LRUCache<string, true>({ max: 10_000, ttl: BACKFILL_TTL_MS });

  async function record(sub: string, name: string, tenant?: string): Promise<void> {
    if (!name.trim() || !deps.signingSecret) return;
    const path = withSourceAuthNonce("/v1/principals/profile", deps.signingSecret);
    const body = JSON.stringify({ principalId: sub, displayName: name });
    try {
      const r = await fetch(`${deps.core}${path}`, {
        method: "POST",
        headers: {
          ...signedHeaders(deps.signingSecret, "POST", path, body),
          ...deps.identityHeaders(sub, tenant),
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (!r.ok) console.warn(`[portal] recording the signed-in name returned HTTP ${r.status}`);
    } catch (error) {
      console.warn(`[portal] recording the signed-in name failed: ${errMessage(error)}`);
    }
  }

  function backfill(sub: string, name: string, tenant?: string): void {
    const key = `${tenant ?? ""}|${sub}`;
    if (backfilled.has(key)) return;
    backfilled.set(key, true);
    void record(sub, name, tenant);
  }

  return { record, backfill };
}
