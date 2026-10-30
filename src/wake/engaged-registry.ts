export interface EngagedRegistry {
  engage(threadRef: string): void;
  settle(threadRef: string): void;
  list(): string[];
}

export function createEngagedRegistry(opts: { maxAgeMs?: number; now?: () => number } = {}): EngagedRegistry {
  const engaged = new Map<string, number>();
  const now = opts.now ?? Date.now;
  const prune = (): void => {
    if (opts.maxAgeMs === undefined) return;
    const cutoff = now() - opts.maxAgeMs;
    for (const [threadRef, at] of engaged) if (at < cutoff) engaged.delete(threadRef);
  };
  return {
    engage: (threadRef) => {
      engaged.delete(threadRef);
      engaged.set(threadRef, now());
      if (engaged.size > 1_000) prune();
    },
    settle: (threadRef) => void engaged.delete(threadRef),
    list: () => {
      prune();
      return [...engaged.keys()];
    },
  };
}
