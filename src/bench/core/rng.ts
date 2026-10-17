function createRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  sample<T>(items: readonly T[], n: number): T[];
  chance(p: number): boolean;
}

export function rng(seed: number): Rng {
  const next = createRng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    shuffle,
    sample: (items, n) => shuffle(items).slice(0, n),
    chance: (p) => next() < p,
  };
}
