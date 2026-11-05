import { AsyncLocalStorage } from "node:async_hooks";

export class WorkAdmissionClosed extends Error {
  constructor() {
    super("This deployment is not accepting synchronous work");
  }
}

export function createAdmittedWork() {
  const context = new AsyncLocalStorage<{ active: boolean }>();
  const pending = new Set<Promise<unknown>>();
  let paused = false;
  const canRun = () => context.getStore()?.active === true || !paused;
  return {
    canRun,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    run<T>(work: () => T | Promise<T>): Promise<T> {
      if (!canRun()) return Promise.reject(new WorkAdmissionClosed());
      const admission = { active: true };
      const task = context.run(admission, () => Promise.resolve().then(work));
      pending.add(task);
      void task
        .finally(() => {
          admission.active = false;
          pending.delete(task);
        })
        .catch(() => {});
      return task;
    },
    async drained() {
      while (pending.size) await Promise.allSettled(pending);
    },
  };
}

export type AdmittedWork = ReturnType<typeof createAdmittedWork>;
