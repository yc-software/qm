import { perTenant } from "../../../src/tenants/context.ts";

const MAX_TRACKED_RUNS = 5000;

const runs = perTenant(() => ({ threadOf: new Map<string, string>(), byThread: new Map<string, string[]>() }));

function threadKey(user: string, threadRef: string): string {
  return `${user}\0${threadRef}`;
}

export function forgetRun(runId: string): void {
  const { threadOf, byThread } = runs();
  const key = threadOf.get(runId);
  if (key) {
    const remaining = (byThread.get(key) ?? []).filter((id) => id !== runId);
    if (remaining.length) byThread.set(key, remaining);
    else byThread.delete(key);
  }
  threadOf.delete(runId);
}

export function rememberRun(runId: string, user: string, threadRef: string): void {
  const { threadOf, byThread } = runs();
  if (threadOf.size > MAX_TRACKED_RUNS) {
    const oldest = threadOf.keys().next().value;
    if (oldest !== undefined) forgetRun(oldest);
  }
  const key = threadKey(user, threadRef);
  threadOf.set(runId, key);
  byThread.set(key, [...(byThread.get(key) ?? []), runId]);
}

export function activeRuns(user: string, threadRef: string): string[] {
  return [...(runs().byThread.get(threadKey(user, threadRef)) ?? [])];
}
