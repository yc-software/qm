import { AsyncLocalStorage } from "node:async_hooks";

const operationContext = new AsyncLocalStorage<AbortSignal>();

export function getOperationSignal(): AbortSignal | undefined {
  return operationContext.getStore();
}

export function assertOperationActive(): void {
  getOperationSignal()?.throwIfAborted();
}

export function withOperationSignal<T>(signal: AbortSignal | undefined, work: () => T): T {
  const parent = getOperationSignal();
  const combined = signal && parent && signal !== parent ? AbortSignal.any([parent, signal]) : (signal ?? parent);
  combined?.throwIfAborted();
  return combined ? operationContext.run(combined, work) : work();
}

export async function withCleanupSignal<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Cleanup timeout must be positive");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Cleanup timed out", "TimeoutError")), timeoutMs);
  timer.unref?.();
  try {
    return await operationContext.run(controller.signal, () => withAbort(work, controller.signal));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

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
    const signal = getOperationSignal();
    const run = withAbort(() => prev, signal).then(() => {
      signal?.throwIfAborted();
      return fn();
    });
    const tail = Promise.allSettled([prev, run]).then(
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

export async function withAbort<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return start();
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return start();
    });
    const value = await Promise.race([operation, cancelled]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
