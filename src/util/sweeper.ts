import { AsyncResource } from "node:async_hooks";
import { reportFailure, reportFailureAs } from "./errors.ts";

export interface Sweeper {
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

interface ScheduledSweep {
  intervalMs: number;
  nextAt: number;
  run(): void;
}

const scheduled = new Set<ScheduledSweep>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = Infinity;

function schedule(): void {
  let nextAt = Infinity;
  for (const entry of scheduled) nextAt = Math.min(nextAt, entry.nextAt);
  if (timer && timerAt === nextAt) return;
  if (timer) clearTimeout(timer);
  timer = null;
  timerAt = nextAt;
  if (!Number.isFinite(nextAt)) return;
  timer = setTimeout(
    () => {
      timer = null;
      timerAt = Infinity;
      const now = performance.now();
      const due = [...scheduled].filter((entry) => entry.nextAt <= now);
      for (const entry of due) {
        if (!scheduled.has(entry)) continue;
        entry.nextAt = now + entry.intervalMs;
        entry.run();
      }
      schedule();
    },
    Math.max(1, Math.ceil(nextAt - performance.now())),
  );
  timer.unref?.();
}

export function createSweeper(
  fn: () => unknown,
  defaultIntervalMs: number,
  opts: { label?: string; immediate?: boolean } = {},
): Sweeper {
  const label = opts.label ?? "sweeper";
  let entry: ScheduledSweep | null = null;
  const pending = new Set<Promise<void>>();
  let stopping: Promise<void> | null = null;
  const sweep = AsyncResource.bind((): void => {
    try {
      const work = Promise.resolve(fn()).then(() => {}, reportFailureAs(`${label}: sweep failed`, undefined));
      pending.add(work);
      void work.finally(() => pending.delete(work));
    } catch (e) {
      reportFailure(`${label}: sweep failed`, e);
    }
  });
  return {
    start(intervalMs?: number) {
      if (entry || stopping) return;
      const requested = intervalMs ?? defaultIntervalMs;
      const interval = requested >= 1 && requested <= 2_147_483_647 ? Math.trunc(requested) : 1;
      entry = { intervalMs: interval, nextAt: performance.now() + interval, run: sweep };
      scheduled.add(entry);
      schedule();
      if (opts.immediate) sweep();
    },
    stop() {
      if (entry) scheduled.delete(entry);
      entry = null;
      schedule();
      stopping ??= Promise.all(pending)
        .then(() => {})
        .finally(() => {
          stopping = null;
        });
      return stopping;
    },
  };
}
