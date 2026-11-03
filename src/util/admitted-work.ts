import { AsyncLocalStorage } from "node:async_hooks";

export class WorkAdmissionClosed extends Error {
  constructor() {
    super("This deployment is not accepting synchronous work");
  }
}

export function createAdmittedWork(
  options: {
    paused?: boolean;
    canStart?: () => boolean;
    bind?: <T>(work: () => T | Promise<T>) => Promise<T>;
  } = {},
) {
  const bind = options.bind ?? (<T>(work: () => T | Promise<T>) => Promise.resolve().then(work));
  const context = new AsyncLocalStorage<{ active: boolean }>();
  const pending = new Set<Promise<unknown>>();
  let paused = options.paused ?? false;
  const canRun = () => context.getStore()?.active === true || (!paused && (options.canStart?.() ?? true));
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
      const task = context.run(admission, () => Promise.resolve().then(() => bind(work)));
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
