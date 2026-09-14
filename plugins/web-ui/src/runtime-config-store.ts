import { fetchRuntimeConfig, updateRuntimeConfig, type RuntimeConfig } from "./core-bridge.ts";
import { swallow } from "../../chassis/src/errors.ts";

type Change = Parameters<typeof updateRuntimeConfig>[1];
type Entry = {
  config: RuntimeConfig | null;
  generation: number;
  fetchedAt: number;
  load: Promise<RuntimeConfig | null> | null;
  write: Promise<void> | null;
  listeners: Set<() => void>;
};
// Reuse boot/multiview reads briefly; returning to a view still revalidates server policy.
const FRESH_MS = 30_000;
const entries = new Map<string, Entry>();
let bootScope: string | null = null;

function entryFor(scopeId: string): Entry {
  let entry = entries.get(scopeId);
  if (!entry) {
    entry = { config: null, generation: 0, fetchedAt: 0, load: null, write: null, listeners: new Set() };
    entries.set(scopeId, entry);
  }
  return entry;
}

export function getRuntimeConfig(scopeId: string | null = bootScope): RuntimeConfig | null {
  return scopeId === null ? null : (entries.get(scopeId)?.config ?? null);
}

function publish(scopeId: string, entry: Entry, config: RuntimeConfig): void {
  if (config.scopeId !== scopeId) throw new Error("Runtime configuration scope mismatch");
  entry.config = config;
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
  bootScope = scopeId;
  if (entry.config || entry.write) return;
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

export async function loadRuntimeConfig(scopeId: string, refresh = false): Promise<RuntimeConfig | null> {
  const entry = entryFor(scopeId);
  // Reads started during a save must not race ahead of that save on the server.
  while (entry.write) await entry.write;
  if (!refresh && entry.config && Date.now() - entry.fetchedAt < FRESH_MS) return entry.config;
  if (entry.load) return entry.load;
  const generation = entry.generation;
  const load = fetchRuntimeConfig(scopeId).then(async (config) => {
    if (generation !== entry.generation) {
      while (entry.write) await entry.write;
      return entry.config;
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
  const save = (entry.write ?? Promise.resolve()).then(async () => {
    const config = await updateRuntimeConfig(scopeId, change);
    publish(scopeId, entry, config);
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
