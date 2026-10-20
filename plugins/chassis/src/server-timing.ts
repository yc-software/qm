import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";
import { performance, type EventLoopUtilization } from "node:perf_hooks";

export interface RequestTiming {
  readonly hop: string;
  readonly startedAt: number;
  readonly loop: EventLoopUtilization;
  readonly phases: Map<string, number>;
  readonly db: { waitMs: number; queryMs: number; queries: number; connects: number };
  route?: string;
  upstream?: string;
}

const store = new AsyncLocalStorage<RequestTiming>();

export function withRequestTiming<T>(hop: string, fn: () => T): T {
  return store.run(
    {
      hop,
      startedAt: performance.now(),
      loop: performance.eventLoopUtilization(),
      phases: new Map(),
      db: { waitMs: 0, queryMs: 0, queries: 0, connects: 0 },
    },
    fn,
  );
}

export function requestTiming(): RequestTiming | undefined {
  return store.getStore();
}

export function timeRoute(route: string): void {
  const timing = store.getStore();
  if (timing) timing.route = route;
}

export function addPhase(phase: string, ms: number, timing = store.getStore()): void {
  if (timing) timing.phases.set(phase, (timing.phases.get(phase) ?? 0) + ms);
}

export async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const timing = store.getStore();
  if (!timing) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    addPhase(phase, performance.now() - started, timing);
  }
}

export function timedSync<T>(phase: string, fn: () => T): T {
  const timing = store.getStore();
  if (!timing) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    addPhase(phase, performance.now() - started, timing);
  }
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

function timingMetrics(timing: RequestTiming): Record<string, number> {
  const metrics: Record<string, number> = Object.fromEntries(timing.phases);
  if (timing.db.queries || timing.db.connects) {
    metrics["db-wait"] = timing.db.waitMs;
    metrics["db-query"] = timing.db.queryMs;
    metrics["db-count"] = timing.db.queries;
    metrics["db-connects"] = timing.db.connects;
  }
  metrics.loop = performance.eventLoopUtilization(timing.loop).active;
  metrics.total = performance.now() - timing.startedAt;
  return Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, round(value)]));
}

export function withServerTiming<T extends Record<string, string | string[]>>(
  headers: T,
  timing = store.getStore(),
): T {
  if (!timing) return headers;
  const own = Object.entries(timingMetrics(timing)).map(([name, value]) => `${timing.hop}-${name};dur=${value}`);
  return { ...headers, "server-timing": [...own, ...(timing.upstream ? [timing.upstream] : [])].join(", ") };
}

export function logRequestTiming(res: ServerResponse, timing: RequestTiming): void {
  if (!timing.route) return;
  console.info(
    `[request-timing] ${JSON.stringify({
      hop: timing.hop,
      route: timing.route,
      status: res.writableFinished ? res.statusCode : 0,
      ...timingMetrics(timing),
    })}`,
  );
}
