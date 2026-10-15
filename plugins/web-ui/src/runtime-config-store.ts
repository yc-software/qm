import { fetchRuntimeConfig, updateRuntimeConfig } from "./core-bridge.ts";
import {
  cacheRuntimeConfig,
  getRuntimeConfig,
  setRuntimeBootScope,
  type RuntimeConfig,
} from "./runtime-config-cache.ts";
import { swallow } from "../../chassis/src/errors.ts";

type Change = Parameters<typeof updateRuntimeConfig>[1];
type Entry = {
  key: string;
  generation: number;
  fetchedAt: number;
  load: Promise<RuntimeConfig | null> | null;
  write: Promise<void> | null;
  listeners: Set<() => void>;
};
// Reuse boot/multiview reads briefly; returning to a view still revalidates server policy.
const FRESH_MS = 30_000;
const entries = new Map<string, Entry>();
let accountRevision = 0;

export function invalidateRuntimeConfigs(): void {
  accountRevision++;
  for (const [key, entry] of entries) {
    entry.generation++;
    cacheRuntimeConfig(key, null);
    entry.fetchedAt = 0;
    entry.load = null;
  }
}

if (typeof window !== "undefined") window.addEventListener("model-account-changed", invalidateRuntimeConfigs);

function entryFor(scopeId: string): Entry {
  let entry = entries.get(scopeId);
  if (!entry) {
    entry = { key: scopeId, generation: 0, fetchedAt: 0, load: null, write: null, listeners: new Set() };
    entries.set(scopeId, entry);
  }
  return entry;
}

function publish(scopeId: string, entry: Entry, config: RuntimeConfig): void {
  if (config.scopeId !== scopeId) throw new Error("Runtime configuration scope mismatch");
  cacheRuntimeConfig(entry.key, config);
  entry.fetchedAt = Date.now();
  for (const listener of entry.listeners) {
    try {
      listener();
    } catch (e) {
      swallow("web-ui: runtime config listener", e);
    }
  }
}

/** Boot hydration is shared by every pane, not consumed by the first mount. */
export function seedRuntimeConfig(scopeId: string, config: RuntimeConfig): void {
  const entry = entryFor(scopeId);
  setRuntimeBootScope(scopeId);
  if (getRuntimeConfig(scopeId) || entry.write) return;
  ++entry.generation;
  publish(scopeId, entry, config);
}

export function subscribeRuntimeConfig(scopeId: string, listener: () => void): () => void {
  const entry = entryFor(scopeId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function runtimeConfigKey(scopeId: string | null, account?: "company"): string | null {
  return scopeId && account ? `${account}/${scopeId}` : scopeId;
}

export async function loadRuntimeConfig(
  scopeId: string,
  refresh = false,
  account?: "company",
): Promise<RuntimeConfig | null> {
  const entry = entryFor(runtimeConfigKey(scopeId, account)!);
  // Reads started during a save must not race ahead of that save on the server.
  while (entry.write) await entry.write;
  const cached = getRuntimeConfig(entry.key);
  if (!refresh && cached && Date.now() - entry.fetchedAt < FRESH_MS) return cached;
  if (entry.load) return entry.load;
  const generation = entry.generation;
  const load = fetchRuntimeConfig(scopeId, account).then(async (config) => {
    if (generation !== entry.generation) {
      while (entry.write) await entry.write;
      return getRuntimeConfig(entry.key);
    }
    if (config) publish(scopeId, entry, config);
    return config;
  });
  entry.load = load;
  try {
    return await load;
  } finally {
    if (entry.load === load) entry.load = null;
  }
}

export async function saveRuntimeConfig(scopeId: string, change: Change): Promise<RuntimeConfig> {
  const entry = entryFor(scopeId);
  // Serialize writes per scope so both the server and every view see the same order.
  // Invalidate old reads at enqueue time, including when the save ultimately fails.
  ++entry.generation;
  entry.load = null;
  const revision = accountRevision;
  const save = (entry.write ?? Promise.resolve()).then(async () => {
    const config = await updateRuntimeConfig(scopeId, change);
    if (revision === accountRevision) publish(scopeId, entry, config);
    return config;
  });
  const settled = save.then(
    () => {},
    () => {},
  );
  entry.write = settled;
  try {
    return await save;
  } finally {
    if (entry.write === settled) entry.write = null;
  }
}
