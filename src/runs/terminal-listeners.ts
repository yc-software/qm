import { reportFailure, reportFailureAs } from "../util/errors.ts";
import type { Run } from "./run-store.ts";

export function createRunTerminalListeners() {
  const listeners: Array<(run: Run) => void | Promise<void>> = [];
  const pending = new Set<Promise<void>>();
  return {
    add(listener: (run: Run) => void | Promise<void>): void {
      listeners.push(listener);
    },
    emit(run: Run): void {
      for (const listener of listeners) {
        try {
          const result = listener(run);
          if (!result) continue;
          const task = result
            .catch(reportFailureAs("run terminal listener", undefined, `run=${run.id}`))
            .finally(() => pending.delete(task));
          pending.add(task);
        } catch (error) {
          reportFailure("run terminal listener", error, `run=${run.id}`);
        }
      }
    },
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled(pending);
    },
  };
}
