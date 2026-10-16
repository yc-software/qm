import { createPgBossAutomationQueue } from "../triggers/job-queue.ts";
import type { WebhookFireJob } from "./webhook-receiver.ts";

export function createPgBossWebhookQueue(databaseUrl: string, schema = "pgboss", concurrency = 1, runWaitMs?: number) {
  return createPgBossAutomationQueue<WebhookFireJob>(databaseUrl, schema, concurrency, {
    name: "webhook-fire",
    key: (job) => `webhook:${job.webhookId}:${job.deliveryId}`,
    startAfter: () => Date.now(),
    retryLimit: 10,
    exclusive: true,
    ...(runWaitMs !== undefined ? { timeoutMs: runWaitMs + 60_000 } : {}),
  });
}
