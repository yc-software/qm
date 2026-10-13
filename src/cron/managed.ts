import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { Cron } from "../types.ts";
import type { CreateCronInput, CronStore } from "./cron-store.ts";
import type { Scheduler } from "./scheduler.ts";

export const nightlyAt = (key: string, hour: number) =>
  `${createHash("sha256").update(key).digest()[0]! % 60} ${hour} * * *`;

export async function claimManagedCron<T extends { cronId?: string }>(
  deps: { store: DurableMap<T>; crons: CronStore; scheduler: Pick<Scheduler, "notifyChanged"> },
  key: string,
  initial: T,
  input: CreateCronInput,
  fields: (cron: Cron) => Partial<T> = () => ({}),
): Promise<T> {
  const cron = await deps.crons.create(input);
  await deps.store.putIfAbsent(key, initial);
  const stored = await deps.store.update?.(key, (value) =>
    value.cronId ? value : { ...value, cronId: cron.id, ...fields(cron) },
  );
  if (!stored) throw new Error("Managed crons require an atomic profile store");
  if (stored.cronId === cron.id) deps.scheduler.notifyChanged(cron.id);
  else await deps.crons.delete(cron.id);
  return stored;
}
