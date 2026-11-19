import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgBossCronQueue, cronQueueMisconfigured, installCronQueue } from "../src/cron/job-queue.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { grantAppRole } from "../src/persistence/app-role-grants.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { APP_ROLE, appUrl, ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

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
  const owner = createPgPool(ownerUrl(databaseUrl).toString());
  const queue = createPgBossCronQueue(appUrl(databaseUrl));
  try {
    const version = (await owner.q("SELECT version FROM pgboss.version"))[0]!.version;
    const enqueue = (name: string, command: string) =>
      owner.q("SELECT pgboss.job_table_run_async($1, $2, $3, 'job_common')", [name, version, command]);
    for (const name of ["install_probe_a", "install_probe_b"])
      await enqueue(name, `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON pgboss.job (name)`);
    await installCronQueue(ownerUrl(databaseUrl).toString());
    const built = await owner.q(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'pgboss' AND indexname LIKE 'install_probe_%' ORDER BY indexname",
    );
    assert.deepEqual(
      built.map((row) => row.indexname),
      ["install_probe_a", "install_probe_b"],
    );
    await grantAppRole((text, params) => owner.q(text, params), APP_ROLE, "pgboss");
    await installCronQueue(appUrl(databaseUrl));
    await queue.start(handlers);
    await queue.enqueueFire({ tenantId: TEST_TENANT, cronId: "c1", scheduledAt: Date.now() });
    const deadline = Date.now() + 10_000;
    while (!fired.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fired, ["c1"]);
    await enqueue(
      "install_probe_failure",
      "CREATE INDEX CONCURRENTLY install_probe_failure ON pgboss.missing_install_probe (id)",
    );
    await assert.rejects(installCronQueue(ownerUrl(databaseUrl).toString()));
    assert.equal(
      (await owner.q("SELECT status FROM pgboss.bam WHERE name = 'install_probe_failure'"))[0]!.status,
      "failed",
    );
  } finally {
    await queue.stop().finally(() => owner.close());
  }
});
