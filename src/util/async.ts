export const sleep = (ms: number, opts?: { unref?: boolean }): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (opts?.unref) t.unref?.();
  });

export async function withTimeout<T>(start: () => Promise<T>, ms: number, label: string): Promise<T> {
  const p = start();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      p.catch(() => undefined);
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createKeyedQueue<K = string>(): <T>(key: K, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<K, Promise<void>>();
  return (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
