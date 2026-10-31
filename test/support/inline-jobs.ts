import type { JobDisposition, JobHandler, JobWorker } from "../../src/jobs/job-worker.ts";

const pending = new Set<Promise<unknown>>();

export async function inlineJobsSettled(): Promise<void> {
  while (pending.size) await Promise.allSettled(pending);
}

export interface InlineJobs extends JobWorker {
  spawned: Array<{ name: string; params: unknown; key: string }>;
  recurring: Map<string, () => unknown>;
  run(name: string, params: unknown): Promise<JobDisposition>;
}

export function createInlineJobs(
  opts: { autoRun?: (name: string) => boolean } = { autoRun: (name) => name !== "cron-fire" },
): InlineJobs {
  const handlers = new Map<string, JobHandler>();
  const settledKeys = new Map<string, JobDisposition | "running">();
  const jobs: InlineJobs = {
    spawned: [],
    recurring: new Map(),
    handle(name, handler) {
      handlers.set(name, handler);
    },
    async spawn(name, params, key) {
      jobs.spawned.push({ name, params, key });
      const previous = settledKeys.get(key);
      if (previous !== undefined && previous !== "release") return;
      settledKeys.set(key, "running");
      if (!opts.autoRun?.(name)) return;
      const work = jobs.run(name, params).then(
        (disposition) => settledKeys.set(key, disposition),
        () => settledKeys.set(key, "release"),
      );
      pending.add(work);
      void work.finally(() => pending.delete(work));
    },
    every(name, _everyMs, fn) {
      jobs.recurring.set(name, fn);
    },
    async run(name, params) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no handler for job ${name}`);
      return handler(params);
    },
    async start() {},
    async stopClaims() {},
    drained: inlineJobsSettled,
    stop: inlineJobsSettled,
  };
  return jobs;
}
