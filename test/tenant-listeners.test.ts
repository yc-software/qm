import "./support/auto-fake-sprites.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { nonOwnerLogin } from "./support/non-owner.ts";
import { useOwnerDatabase } from "../src/tenants/owner-pool.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy tests";
const a: string = randomUUID();
const b: string = randomUUID();
let owner: pg.Pool;
let built: ReturnType<typeof buildApp>;

before(async () => {
  if (skip) return;
  const databaseUrl = testMigratedDatabaseUrl();
  owner = new pg.Pool({ connectionString: databaseUrl });
  await owner.query("INSERT INTO tenants(id) VALUES ($1), ($2)", [a, b]);
  useOwnerDatabase(databaseUrl);
  built = buildApp(
    testConfig({
      databaseUrl: await nonOwnerLogin(databaseUrl),
      dataDir: mkdtempSync(join(tmpdir(), "tenant-listeners-")),
    }),
  );
});

after(async () => {
  await owner?.end();
});

test("a Slack context request reaches only the Slack runtime of the tenant that made it", { skip }, async () => {
  const heard: { listener: string; requestTenant: string }[] = [];
  const offs = [a, b].map((tenant) =>
    withTenant(tenant, () =>
      built.slackCore.onContextRequest((request) =>
        heard.push({ listener: tenant, requestTenant: String(request.query.channelId) }),
      ),
    ),
  );
  const crossTenant: string[] = [];
  const offAll = withoutTenant(() =>
    built.app.onContextRequestCreated((request) => crossTenant.push(String(request.query.channelId))),
  );
  try {
    await withTenant(b, () => built.app.createContextRequest("slack", { channelId: b, count: 1 }));
    await withTenant(a, () => built.app.createContextRequest("slack", { channelId: a, count: 1 }));
    assert.deepEqual(heard, [
      { listener: b, requestTenant: b },
      { listener: a, requestTenant: a },
    ]);
    assert.deepEqual(crossTenant, [b, a]);
  } finally {
    for (const off of offs) off();
    offAll();
  }
});

test("a delivery enqueued in one tenant wakes only that tenant's Slack drain", { skip }, async () => {
  const woke: string[] = [];
  const offs = [a, b].map((tenant) =>
    withTenant(tenant, () => built.slackCore.onDeliveryEnqueued(() => woke.push(tenant))),
  );
  try {
    await withTenant(b, () =>
      built.deliveries.enqueue({
        destination: { type: "slack", target: "C1" },
        text: "hello",
        idempotencyKey: randomUUID(),
      }),
    );
    assert.deepEqual(woke, [b]);
  } finally {
    for (const off of offs) off();
  }
});
