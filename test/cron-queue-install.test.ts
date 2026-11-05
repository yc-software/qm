import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgBossCronQueue, cronQueueMisconfigured, installCronQueue } from "../src/cron/job-queue.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the cron queue install tests";

test("the owner installs the cron queue at migrate time and the app login only uses it", { skip }, async () => {
  const databaseUrl = testDatabaseUrl();
  const fired: string[] = [];
  const handlers = { onFire: async (job: { cronId: string }) => void fired.push(job.cronId) };
  const early = createPgBossCronQueue(appUrl(databaseUrl));
  const refused = await early.start(handlers).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(cronQueueMisconfigured(refused), String(refused));
  await installCronQueue(ownerUrl(databaseUrl).toString());
  await installCronQueue(appUrl(databaseUrl));
  const queue = createPgBossCronQueue(appUrl(databaseUrl));
  try {
    await queue.start(handlers);
    await queue.enqueueFire({ tenantId: TEST_TENANT, cronId: "c1", scheduledAt: Date.now() });
    const deadline = Date.now() + 10_000;
    while (!fired.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fired, ["c1"]);
  } finally {
    await queue.stop();
  }
});
