import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";

export interface HandedOffFire {
  fireKey: string;
  firedAt: number;
}

export const REDRIVE_MIN_AGE_MS = 60_000;

export async function redriveHandedOffFires<F extends HandedOffFire>(
  fires: Iterable<F>,
  opts: {
    now: number;
    idempotency: Pick<IdempotencyStore, "committed">;
    stopped?: () => boolean;
    refire: (fire: F) => void | Promise<void>;
  },
): Promise<void> {
  for (const fire of fires) {
    if (opts.stopped?.()) return;
    if (fire.firedAt > opts.now - REDRIVE_MIN_AGE_MS || (await opts.idempotency.committed(fire.fireKey))) continue;
    await opts.refire(fire);
  }
}
