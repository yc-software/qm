import { createPgBossAutomationQueue, type AutomationJobQueue } from "../triggers/job-queue.ts";

export interface CronFireJob {
  cronId: string;
  scheduledAt: number;
  notBefore?: number;
}

export type CronJobQueue = AutomationJobQueue<CronFireJob>;

export function createPgBossCronQueue(
  databaseUrl: string,
  schema = "pgboss",
  fireConcurrency = 1,
  runWaitMs?: number,
): CronJobQueue {
  return createPgBossAutomationQueue(databaseUrl, schema, fireConcurrency, {
    name: "cron-fire",
    key: (job: CronFireJob) => `${job.cronId}:${job.scheduledAt}`,
    startAfter: (job) => Math.max(job.scheduledAt, job.notBefore ?? 0),
    retryLimit: 0,
    ...(runWaitMs !== undefined ? { timeoutMs: runWaitMs + 60_000 } : {}),
  });
}
