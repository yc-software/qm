import type { RuntimeConfig } from "./core-bridge.ts";

export const RUNTIME_CONFIG_CACHE_TTL_MS = 30_000;

export class RuntimeConfigCache {
  readonly #entries = new Map<string, { config: RuntimeConfig; storedAtMs: number }>();
  readonly #revisions = new Map<string, number>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(now: () => number = Date.now, ttlMs = RUNTIME_CONFIG_CACHE_TTL_MS) {
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  get(scopeId: string | null): RuntimeConfig | null {
    if (!scopeId) return null;
    const entry = this.#entries.get(scopeId);
    if (!entry) return null;
    if (this.#now() - entry.storedAtMs < this.#ttlMs) return entry.config;
    this.#entries.delete(scopeId);
    return null;
  }

  set(scopeId: string | null, config: RuntimeConfig): void {
    if (!scopeId) return;
    this.#entries.set(scopeId, { config, storedAtMs: this.#now() });
    this.#revisions.set(scopeId, this.revision(scopeId) + 1);
  }

  invalidate(scopeId: string | null): void {
    if (!scopeId) return;
    this.#entries.delete(scopeId);
    this.#revisions.set(scopeId, this.revision(scopeId) + 1);
  }

  revision(scopeId: string): number {
    return this.#revisions.get(scopeId) ?? 0;
  }

  resolveFetch(scopeId: string, expectedRevision: number, config: RuntimeConfig | null): RuntimeConfig | null {
    if (this.revision(scopeId) !== expectedRevision) return this.get(scopeId);
    if (!config) return null;
    this.set(scopeId, config);
    return config;
  }
}

export const runtimeConfigCache = new RuntimeConfigCache();

const runtimeMutationTails = new Map<string, Promise<void>>();

export async function updateCachedRuntimeConfig(
  scopeId: string,
  update: () => Promise<RuntimeConfig>,
): Promise<RuntimeConfig> {
  const predecessor = runtimeMutationTails.get(scopeId) ?? Promise.resolve();
  let release = (): void => {};
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => lock);
  runtimeMutationTails.set(scopeId, tail);
  await predecessor;
  try {
    const config = await update();
    runtimeConfigCache.set(scopeId, config);
    return config;
  } finally {
    release();
    if (runtimeMutationTails.get(scopeId) === tail) runtimeMutationTails.delete(scopeId);
  }
}
