import { swallow, swallowAs } from "./errors.ts";

export interface Sweeper {
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

export function createSweeper(
  fn: () => unknown,
  defaultIntervalMs: number,
  opts: { label?: string; immediate?: boolean } = {},
): Sweeper {
  const label = opts.label ?? "sweeper";
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  const sweep = (): void => {
    if (inFlight) return;
    try {
      inFlight = Promise.resolve(fn())
        .then(() => undefined)
        .catch(swallowAs(`${label}: sweep failed`, undefined))
        .finally(() => {
          inFlight = null;
        });
    } catch (e) {
      swallow(`${label}: sweep failed`, e);
    }
  };
  return {
    start(intervalMs?: number) {
      if (timer) return;
      timer = setInterval(sweep, intervalMs ?? defaultIntervalMs);
      timer.unref?.();
      if (opts.immediate) sweep();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
    },
  };
}
