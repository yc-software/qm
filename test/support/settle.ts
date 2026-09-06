import type { Scheduler } from "../../src/cron/scheduler.ts";

export async function runNowSettled(scheduler: Scheduler, cronId: string): Promise<void> {
  const r = await scheduler.runNow(cronId);
  if (r.started) await r.settled;
}

export const settle = async (check: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (lastError !== undefined) console.error("[settle] condition never held; last error:", lastError);
};
