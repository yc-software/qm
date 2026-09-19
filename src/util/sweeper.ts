import { reportFailure, reportFailureAs } from "./errors.ts";
import { withOperationSignal } from "./async.ts";

export interface Sweeper {
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

export function createSweeper(
  fn: (signal: AbortSignal) => unknown,
  defaultIntervalMs: number,
  opts: { label?: string; immediate?: boolean } = {},
): Sweeper {
  const label = opts.label ?? "sweeper";
  let timer: ReturnType<typeof setInterval> | null = null;
  let controller = new AbortController();
  const pending = new Set<Promise<void>>();
  let stopping: Promise<void> | null = null;
  const sweep = (): void => {
    try {
      const work = Promise.resolve(withOperationSignal(controller.signal, () => fn(controller.signal))).then(
        () => {},
        reportFailureAs(`${label}: sweep failed`, undefined),
      );
      pending.add(work);
      void work.finally(() => pending.delete(work));
    } catch (e) {
      reportFailure(`${label}: sweep failed`, e);
    }
  };
  return {
    start(intervalMs?: number) {
      if (timer || stopping) return;
      controller = new AbortController();
      timer = setInterval(sweep, intervalMs ?? defaultIntervalMs);
      timer.unref?.();
      if (opts.immediate) sweep();
    },
    stop() {
      controller.abort();
      if (timer) clearInterval(timer);
      timer = null;
      stopping ??= Promise.all(pending)
        .then(() => {})
        .finally(() => {
          stopping = null;
        });
      return stopping;
    },
  };
}
