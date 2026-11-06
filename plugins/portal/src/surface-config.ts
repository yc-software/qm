import { LRUCache } from "lru-cache";

export interface SurfaceConfig {
  accent?: string;
  selfLabel?: string;
  modelProviderConfigured?: boolean;
}

interface Entry {
  accent: string;
  selfLabel?: string | undefined;
  modelProviderConfigured: boolean | undefined;
  nextAt: number;
  inflight: Promise<void> | null;
}

export function createSurfaceConfigs(
  neutralAccent: string,
  fetchConfig: (tenant?: string, sub?: string) => Promise<SurfaceConfig | null>,
) {
  const entries = new LRUCache<string, Entry>({ max: 1_000 });
  const entry = (tenant?: string): Entry => {
    const key = tenant ?? "";
    let found = entries.get(key);
    if (!found) {
      found = { accent: neutralAccent, modelProviderConfigured: undefined, nextAt: 0, inflight: null };
      entries.set(key, found);
    }
    return found;
  };
  async function load(e: Entry, tenant?: string, sub?: string): Promise<void> {
    const body = await fetchConfig(tenant, sub).catch(() => null);
    if (!body) return;
    e.accent = body.accent ?? neutralAccent;
    e.selfLabel = body.selfLabel;
    e.modelProviderConfigured = body.modelProviderConfigured;
    e.nextAt = Date.now() + (e.modelProviderConfigured === false ? 5_000 : 30_000);
  }
  return {
    refresh(tenant?: string, sub?: string): Promise<void> {
      const e = entry(tenant);
      if (Date.now() >= e.nextAt) {
        e.nextAt = Date.now() + 5_000;
        e.inflight = load(e, tenant, sub).finally(() => {
          e.inflight = null;
        });
      }
      return e.inflight ?? Promise.resolve();
    },
    accent: (tenant?: string): string => entries.get(tenant ?? "")?.accent ?? neutralAccent,
    selfLabel: (tenant?: string): string | undefined => entries.get(tenant ?? "")?.selfLabel,
    modelProviderConfigured: (tenant?: string): boolean | undefined =>
      entries.get(tenant ?? "")?.modelProviderConfigured,
  };
}
