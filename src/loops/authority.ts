import type { Cron, Loop } from "../types.ts";
import type { CronStore } from "../cron/cron-store.ts";

export async function boundLoopCron(
  loop: Loop,
  crons?: Pick<CronStore, "get">,
  firingCronId?: string,
): Promise<Cron | null> {
  if (!loop.cronId) {
    if (firingCronId) throw new Error("loop is not bound to the firing cron");
    return null;
  }
  const cron = await crons?.get(loop.cronId);
  if (
    !cron ||
    (firingCronId !== undefined && firingCronId !== cron.id) ||
    cron.owner !== loop.owner ||
    cron.ownerScopeId !== loop.ownerScopeId ||
    (cron.runAs ?? "owner") !== (loop.runAs ?? "owner")
  ) {
    throw new Error("loop cron authority binding mismatch");
  }
  if (loop.surface === "inbox" && cron.loopId === undefined && firingCronId === undefined) return cron;
  if (cron.loopId !== loop.id) throw new Error("loop cron authority binding mismatch");
  return cron;
}
