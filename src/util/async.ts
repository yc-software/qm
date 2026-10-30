import { swallowAs } from "./errors.ts";

export function sleep(ms: number, opts: { unref?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const { signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (opts.unref) timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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

export type RetryClass = "idempotent" | "refused";

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

export interface RetryOptions extends BackoffOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RetryDecision = (error: unknown, attempt: number) => number | undefined;

export interface RetryOperationOptions<T> extends RetryOptions {
  statusOf: (error: unknown) => number | undefined;
  networkError?: (error: unknown) => boolean;
  retryAfterMsOf?: (error: unknown) => number | undefined;
  onLate?: (value: T) => Promise<unknown>;
}

export function retryDelay(priorErrors: number): number {
  const base = Math.min(60_000, 15_000 * 2 ** Math.min(Math.max(0, priorErrors), 2));
  return Math.min(60_000, Math.round(base * (1 + Math.random() * 0.2)));
}

function classifiedDelay<T>(retry: RetryClass, opts: RetryOperationOptions<T>): RetryDecision {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  return (error, attempt) => {
    const status = opts.statusOf(error);
    const transient =
      status === undefined
        ? retry === "idempotent" && (isNetworkError(error) || opts.networkError?.(error) === true)
        : retryableStatus(retry, status);
    if (!transient || attempt >= attempts) return undefined;
    return opts.retryAfterMsOf?.(error) ?? jitteredBackoffMs(attempt, opts);
  };
}

export function retryOperation<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  retry: RetryClass,
  opts: RetryOperationOptions<T>,
): Promise<T>;
export function retryOperation<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  retry: RetryDecision,
  opts?: RetryOptions,
): Promise<T>;
export async function retryOperation<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  retry: RetryClass | RetryDecision,
  opts: RetryOptions & Partial<RetryOperationOptions<T>> = {},
): Promise<T> {
  const decide = typeof retry === "function" ? retry : classifiedDelay(retry, opts as RetryOperationOptions<T>);
  const timeoutMs = opts.timeoutMs ?? (typeof retry === "function" ? undefined : 60_000);
  const bounds = [opts.signal, timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)].filter(
    (bound): bound is AbortSignal => bound !== undefined,
  );
  const signal = AbortSignal.any(bounds);
  for (let attempt = 1; ; attempt++) {
    const pending: { attempt?: Promise<T> } = {};
    try {
      return await withAbort(() => (pending.attempt = operation(signal, attempt)), signal);
    } catch (error) {
      if (signal.aborted && pending.attempt && opts.onLate)
        void pending.attempt
          .then(opts.onLate, swallowAs("retryOperation: late attempt failed", undefined))
          .catch(swallowAs("retryOperation: late result handler", undefined));
      signal.throwIfAborted();
      const ms = decide(error, attempt);
      if (ms === undefined) throw error;
      await sleep(ms, { signal });
    }
  }
}

class RetryableResponse {
  readonly response: Response;
  constructor(response: Response) {
    this.response = response;
  }
}

export async function fetchWithRetry(
  send: (signal: AbortSignal) => Promise<Response>,
  retry: RetryClass,
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  return retryOperation(
    async (signal, attempt) => {
      const res = await send(signal);
      if (!retryableStatus(retry, res.status) || attempt >= attempts) return res;
      await withAbort(() => res.body?.cancel().catch(() => undefined) ?? Promise.resolve(), signal);
      throw new RetryableResponse(res);
    },
    retry,
    {
      ...opts,
      statusOf: (e) => (e instanceof RetryableResponse ? e.response.status : undefined),
      networkError: (e) => !isAbortError(e),
      retryAfterMsOf: (e) => (e instanceof RetryableResponse ? retryAfterMs(e.response.headers) : undefined),
    },
  );
}
