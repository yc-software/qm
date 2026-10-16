import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { Cron } from "../types.ts";
import type { CreateCronInput, CronStore } from "./cron-store.ts";
import type { Scheduler } from "./scheduler.ts";

export const nightlyAt = (key: string, hour: number) =>
  `${createHash("sha256").update(key).digest()[0]! % 60} ${hour} * * *`;

export interface ManagedCronClaim {
  cronId?: string;
  arming?: boolean;
  managedAction?: string;
}

type ManagedCronDeps<T> = { store: DurableMap<T>; crons: CronStore; scheduler: Pick<Scheduler, "notifyChanged"> };

export async function claimManagedCron<T extends ManagedCronClaim>(
  deps: ManagedCronDeps<T>,
  key: string,
  initial: T,
  input: CreateCronInput,
  fields: (cron: Cron) => Partial<T> = () => ({}),
): Promise<T> {
  if (!deps.store.update) throw new Error("Managed crons require an atomic profile store");
  const existing = await deps.store.get(key);
  if (existing?.cronId) return existing.arming ? arm(deps, key, existing.cronId) : existing;
  const cron = await deps.crons.create({ ...input, enabled: false });
  await deps.store.putIfAbsent(key, initial);
  const stored = await deps.store.update(key, (value) =>
    value.cronId ? value : { ...value, cronId: cron.id, arming: true, ...fields(cron) },
  );
  if (stored?.cronId === cron.id) return arm(deps, key, cron.id);
  await deps.crons.delete(cron.id);
  return stored ?? initial;
}

export async function refreshManagedAction<T extends ManagedCronClaim>(
  deps: Pick<ManagedCronDeps<T>, "store" | "crons">,
  key: string,
  cron: Cron,
  recorded: string | undefined,
  desired: string,
): Promise<void> {
  if (cron.action !== desired) {
    if (cron.action !== recorded) return;
    await deps.crons.update(cron.id, { action: desired });
  }
  if (recorded !== desired) await deps.store.merge(key, { managedAction: desired } as Partial<T>);
}

async function arm<T extends ManagedCronClaim>(deps: ManagedCronDeps<T>, key: string, cronId: string): Promise<T> {
  await deps.crons.setEnabled(cronId, true);
  deps.scheduler.notifyChanged(cronId);
  const armed = await deps.store.update!(key, ({ arming: _arming, ...value }) => value as T);
  if (!armed) throw new Error(`managed cron profile ${key} disappeared while arming`);
  return armed;
}
