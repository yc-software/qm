import { DECISION_LEASE_MS } from "./item-ledger.ts";
import type { Loop } from "../types.ts";
import type { LoopServiceDeps } from "../api/routes/loops.ts";
import type { UiStateStore } from "../surfaces/ui-state.ts";
import { uiStateId } from "../surfaces/ui-state.ts";
import { renderSourceInboxTask } from "./inbox-loop.ts";

interface Migration {
  phase: "pending" | "complete";
  enabled: boolean;
}

async function migrateInboxLocked(
  deps: LoopServiceDeps,
  preferences: UiStateStore,
  legacy: Loop,
  defaults: Loop[],
): Promise<boolean> {
  const key = uiStateId(legacy.owner, "inbox-migration");
  const cron = legacy.cronId ? await deps.crons?.get(legacy.cronId) : null;
  const record = await preferences.putIfAbsent(key, {
    value: { phase: "pending", enabled: legacy.state === "enabled" && cron?.enabled === true } satisfies Migration,
    updatedAt: Date.now(),
  });
  const migration = record.value as Migration;
  if (migration.phase === "complete") return true;
  await deps.store.setState(legacy.id, "paused");
  if (cron) await deps.crons!.setEnabled(cron.id, false);
  if (cron && (await deps.crons!.listFires(cron.id)).runs.some((fire) => fire.status === "running")) return false;
  const items = await deps.items.byLoop(legacy.id);
  if (
    items.some(
      (item) =>
        item.status === "in_progress" ||
        (item.decisionToken && (item.decisionAt ?? 0) + DECISION_LEASE_MS > Date.now()),
    )
  )
    return false;
  const outputs = await deps.outputs.byLoop(legacy.id);
  if (outputs.some((output) => output.state === "shipping")) return false;
  for (const loop of defaults) {
    const source = loop.sources?.[0];
    if (!source) continue;
    await deps.items.moveSource(legacy.id, loop.id, source);
    for (const item of await deps.items.byLoop(loop.id)) {
      if (item.previousLoopId === legacy.id) await deps.outputs.rebindItem(item.id, legacy.id, loop.id);
    }
    if (cron && deps.crons) {
      const current = await deps.store.get(loop.id);
      const replacement =
        (current?.cronId ? await deps.crons.get(current.cronId) : null) ??
        (await deps.crons.create({
          loopId: loop.id,
          owner: loop.owner,
          createdBy: loop.owner,
          ownerScopeId: loop.ownerScopeId,
          destination: cron.destination,
          schedule: cron.schedule,
          title: `${loop.name} sync`,
          action: renderSourceInboxTask(loop.id, source),
          runAs: cron.runAs,
          members: cron.members,
          unattendedGrants: cron.unattendedGrants,
          enabled: false,
        }));
      await deps.store.update(loop.id, { cronId: replacement.id, runAs: cron.runAs ?? "owner" });
    }
    if (!migration.enabled) await deps.store.setState(loop.id, "paused");
  }
  if ((await deps.items.byLoop(legacy.id)).some((item) => item.source === "gmail" || item.source === "slack"))
    return false;
  for (const output of await deps.outputs.byLoop(legacy.id)) {
    const item = await deps.items.get(output.itemId);
    if (item?.previousLoopId === legacy.id && item.loopId !== legacy.id) return false;
  }
  if (migration.enabled) {
    for (const loop of defaults) {
      const current = await deps.store.get(loop.id);
      if (current?.cronId && current.state === "enabled") await deps.crons?.setEnabled(current.cronId, true);
    }
  }
  if (cron) await deps.crons!.update(cron.id, { archived: true, enabled: false });
  await deps.store.setState(legacy.id, "archived");
  await preferences.put(key, { value: { ...migration, phase: "complete" }, updatedAt: Date.now() });
  return true;
}

export async function migrateInbox(
  deps: LoopServiceDeps,
  preferences: UiStateStore,
  legacy: Loop,
  defaults: Loop[],
): Promise<boolean> {
  let run = () => migrateInboxLocked(deps, preferences, legacy, defaults);
  if (deps.lock) {
    const lock = deps.lock;
    const loops = await Promise.all([legacy, ...defaults].map(async (loop) => (await deps.store.get(loop.id)) ?? loop));
    const keys = loops.flatMap((loop) => [
      `loop-lifecycle:${loop.id}`,
      `loop-intake:${loop.id}`,
      ...(loop.cronId ? [`cron-lifecycle:${loop.cronId}`] : []),
    ]);
    if (lock.tryWithLocks) return (await lock.tryWithLocks(keys, run)) ?? false;
    for (const key of keys.sort().reverse()) {
      const next = run;
      run = async () => (lock.tryWithLock ? ((await lock.tryWithLock(key, next)) ?? false) : lock.withLock(key, next));
    }
  }
  return run();
}
