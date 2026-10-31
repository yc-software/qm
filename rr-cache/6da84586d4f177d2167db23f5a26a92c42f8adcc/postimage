import { boundTenant } from "../tenants/context.ts";

export interface EngagedSession {
  tenantId?: string;
  threadRef: string;
}

export interface EngagedRegistry {
  engage(threadRef: string): void;
  settle(threadRef: string): void;
  list(): EngagedSession[];
}

export function createEngagedRegistry(opts: { maxAgeMs?: number; now?: () => number } = {}): EngagedRegistry {
  const engaged = new Map<string, EngagedSession & { at: number }>();
  const key = (threadRef: string) => `${boundTenant() ?? ""}\n${threadRef}`;
  const now = opts.now ?? Date.now;
  const prune = (): void => {
    if (opts.maxAgeMs === undefined) return;
    const cutoff = now() - opts.maxAgeMs;
    for (const [k, session] of engaged) if (session.at < cutoff) engaged.delete(k);
  };
  return {
    engage: (threadRef) => {
      const k = key(threadRef);
      const tenantId = boundTenant();
      engaged.delete(k);
      engaged.set(k, { ...(tenantId ? { tenantId } : {}), threadRef, at: now() });
      if (engaged.size > 1_000) prune();
    },
    settle: (threadRef) => void engaged.delete(key(threadRef)),
    list: () => {
      prune();
      return [...engaged.values()].map(({ at: _at, ...session }) => session);
    },
  };
}
