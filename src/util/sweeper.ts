import { swallow, swallowAs } from "./errors.ts";

export interface Sweeper {
  start(intervalMs?: number): void;
  stop(): void;
}

export function createSweeper(
  fn: () => unknown,
  defaultIntervalMs: number,
  opts: { label?: string; immediate?: boolean } = {},
): Sweeper {
  const label = opts.label ?? "sweeper";
  let timer: ReturnType<typeof setInterval> | null = null;
  const sweep = (): void => {
    try {
      void Promise.resolve(fn()).catch(swallowAs(`${label}: sweep failed`, undefined));
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
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
