import { setTimeout as delay } from "node:timers/promises";
import { swallowAs } from "./errors.ts";

export const sleep = (ms: number, opts?: { unref?: boolean }): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (opts?.unref) t.unref?.();
  });

export class TimeoutError extends Error {}

export async function withTimeout<T>(start: () => Promise<T>, ms: number, label: string): Promise<T> {
  const p = start();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      p.catch(() => undefined);
      reject(new TimeoutError(`${label} timed out after ${ms}ms`));
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

export function createTtlRefresh(ttlMs: number, load: () => Promise<void>): (force?: boolean) => Promise<void> {
  let refreshedAt = 0;
  let pending: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const start = (): Promise<void> =>
    (pending = load()
      .then(() => {
        refreshedAt = Date.now();
      })
      .finally(() => {
        pending = null;
      }));
  return (force = false) => {
    if (next) return force ? next : (pending ?? next);
    if (pending && !force) return pending;
    if (pending)
      return (next = pending
        .catch(() => undefined)
        .then(() => {
          next = null;
          return start();
        }));
    if (!force && Date.now() - refreshedAt < ttlMs) return Promise.resolve();
    return start();
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

interface BackoffOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const RETRY_AFTER_CAP_MS = 30_000;
const REFUSED_STATUSES: ReadonlySet<number> = new Set([429]);
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

type RetryClass = "idempotent" | "refused";

function retryableStatus(retry: RetryClass, status: number): boolean {
  return (retry === "idempotent" ? TRANSIENT_STATUSES : REFUSED_STATUSES).has(status);
}

function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && (e.message === "fetch failed" || e.message === "terminated");
}

interface RetryOptions extends BackoffOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RetryOperationOptions<T> extends RetryOptions {
  statusOf: (error: unknown) => number | undefined;
  networkError?: (error: unknown) => boolean;
  retryAfterMsOf?: (error: unknown) => number | undefined;
  onLate?: (value: T) => Promise<unknown>;
}

export async function retryOperation<T>(
  operation: (signal: AbortSignal, last: boolean) => Promise<T>,
  retry: RetryClass,
  opts: RetryOperationOptions<T>,
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  for (let attempt = 1; ; attempt++) {
    const pending: { attempt?: Promise<T> } = {};
    try {
      return await withAbort(() => (pending.attempt = operation(signal, attempt >= attempts)), signal);
    } catch (error) {
      if (signal.aborted && pending.attempt && opts.onLate)
        void pending.attempt
          .then(opts.onLate, swallowAs("retryOperation: late attempt failed", undefined))
          .catch(swallowAs("retryOperation: late result handler", undefined));
      signal.throwIfAborted();
      const status = opts.statusOf(error);
      const transient =
        status === undefined
          ? retry === "idempotent" && (isNetworkError(error) || opts.networkError?.(error) === true)
          : retryableStatus(retry, status);
      if (!transient || attempt >= attempts) throw error;
      try {
        await delay(opts.retryAfterMsOf?.(error) ?? jitteredBackoffMs(attempt, opts), undefined, { signal });
      } catch (waitError) {
        signal.throwIfAborted();
        throw waitError;
      }
    }
  }
}

class RetryableResponse extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super(`HTTP ${response.status}`);
    this.response = response;
  }
}

export function fetchWithRetry(
  send: (signal: AbortSignal) => Promise<Response>,
  retry: RetryClass,
  opts: RetryOptions = {},
): Promise<Response> {
  return retryOperation(
    async (signal, last) => {
      const res = await send(signal);
      if (last || !retryableStatus(retry, res.status)) return res;
      await res.body?.cancel().catch(() => undefined);
      throw new RetryableResponse(res);
    },
    retry,
    {
      ...opts,
      statusOf: (error) => (error instanceof RetryableResponse ? error.response.status : undefined),
      networkError: (error) => !isAbortError(error),
      retryAfterMsOf: (error) =>
        error instanceof RetryableResponse ? retryAfterMs(error.response.headers) : undefined,
    },
  );
}
