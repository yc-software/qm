import { createHash } from "node:crypto";
import type { Cron } from "../triggers/types.ts";
import type { CreateCronInput, CronStore } from "./cron-store.ts";
import type { CronChangeNotifier } from "./fires.ts";

export const nightlyAt = (key: string, hour: number) =>
  `${createHash("sha256").update(key).digest()[0]! % 60} ${hour} * * *`;

export interface ManagedCronClaim {
  cronId?: string;
  arming?: boolean;
}

export interface ManagedCronProfiles<T> {
  get(key: string): Promise<T | null>;
  insertIfAbsent(key: string, initial: T): Promise<T>;
  update(key: string, apply: (profile: T) => T): Promise<T | null>;
}

type ManagedCronDeps<T> = {
  store: ManagedCronProfiles<T>;
  crons: CronStore;
  scheduler: CronChangeNotifier;
};

export async function claimManagedCron<T extends ManagedCronClaim>(
  deps: ManagedCronDeps<T>,
  key: string,
  initial: T,
  input: CreateCronInput,
  fields: (cron: Cron) => Partial<T> = () => ({}),
): Promise<T> {
  const existing = await deps.store.get(key);
  if (existing?.cronId) return existing.arming ? arm(deps, key, existing.cronId) : existing;
  const cron = await deps.crons.create({ ...input, enabled: false });
  await deps.store.insertIfAbsent(key, initial);
  const stored = await deps.store.update(key, (value) =>
    value.cronId ? value : { ...value, cronId: cron.id, arming: true, ...fields(cron) },
  );
  if (stored?.cronId === cron.id) return arm(deps, key, cron.id);
  await deps.crons.delete(cron.id);
  return stored ?? initial;
}

async function arm<T extends ManagedCronClaim>(deps: ManagedCronDeps<T>, key: string, cronId: string): Promise<T> {
  await deps.crons.setEnabled(cronId, true);
  deps.scheduler.notifyChanged(cronId);
  const armed = await deps.store.update(key, ({ arming: _arming, ...value }) => value as T);
  if (!armed) throw new Error(`managed cron profile ${key} disappeared while arming`);
  return armed;
}
