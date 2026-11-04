export type ExpiringCache<V> = {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
};

export function expiringCache<V>(max: number, ttlMs: number): ExpiringCache<V> {
  const entries = new Map<string, { value: V; expiresAt: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt > Date.now()) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      const oldest = entries.keys().next();
      if (entries.size > max && !oldest.done) entries.delete(oldest.value);
    },
  };
}
