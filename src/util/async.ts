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

export interface BackoffOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const RETRY_AFTER_CAP_MS = 30_000;
const REFUSED_STATUSES: ReadonlySet<number> = new Set([429, 503]);
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export function jitteredBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds < 0 ? undefined : Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - now), RETRY_AFTER_CAP_MS);
}

export type RetryClass = "idempotent" | "refused";

function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export async function fetchWithRetry(
  send: () => Promise<Response>,
  retry: RetryClass,
  opts: BackoffOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const statuses = retry === "idempotent" ? TRANSIENT_STATUSES : REFUSED_STATUSES;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await send();
    } catch (e) {
      if (retry !== "idempotent" || attempt >= attempts || isAbortError(e)) throw e;
      await sleep(jitteredBackoffMs(attempt, opts));
      continue;
    }
    if (!statuses.has(res.status) || attempt >= attempts) return res;
    await res.body?.cancel().catch(() => undefined);
    await sleep(retryAfterMs(res.headers) ?? jitteredBackoffMs(attempt, opts));
  }
}
