import type { Scheduler } from "../../src/cron/scheduler.ts";
import { inlineJobsSettled } from "./inline-jobs.ts";

export async function runNowSettled(scheduler: Scheduler, cronId: string): Promise<void> {
  const r = await scheduler.runNow(cronId);
  if (r.started) await inlineJobsSettled();
}

export async function settle(check: () => Promise<boolean>): Promise<void> {
  await eventually(check);
}

export async function eventually<T>(
  read: () => T | Promise<T>,
  opts: { until?: (value: T) => unknown; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const { until = Boolean, timeoutMs = 15_000, label = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await read();
      if (until(value)) return value;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) throw new Error(`${label} did not hold within ${timeoutMs}ms`, { cause: lastError });
    await new Promise((r) => setTimeout(r, 20));
  }
}
