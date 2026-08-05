export const sleep = (ms: number, opts?: { unref?: boolean; signal?: AbortSignal }): Promise<void> =>
  new Promise((r) => {
    if (opts?.signal?.aborted) {
      r();
      return;
    }
    const t = setTimeout(() => {
      opts?.signal?.removeEventListener("abort", onAbort);
      r();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      r();
    };
    if (opts?.unref) t.unref?.();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
  });

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
