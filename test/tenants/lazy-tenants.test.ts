import "../support/auto-fake-sprites.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createJobWorker, hasRows } from "../../src/jobs/job-worker.ts";
import { createPgPool, migrateRegisteredPgSchemas, type PgPool } from "../../src/persistence/pg-pool.ts";
import {
  cachedTenantCount,
  holdTenant,
  perTenant,
  tenant,
  tenantFor,
  withTenant,
  type Tenant,
} from "../../src/tenant.ts";
import { createTenantDirectory, useTenantDirectory, type TenantDirectory } from "../../src/tenants/directory.ts";
import { buildApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockHarness } from "../support/mock-harness.ts";
import { stopAtEnd } from "../support/build-app.ts";
import { settle } from "../support/settle.ts";
import { testConfig } from "../support/test-config.ts";

const URL_ADMIN = process.env.DATABASE_URL;
const skip = URL_ADMIN ? false : "set DATABASE_URL (a Postgres) to run the lazy tenant test";
const DB = `qm_lazy_${process.pid}`;
const ROLE = "qm_lazy_app";
const TENANTS = 2_000;

let admin: pg.Client;
let databaseUrl = "";
let rls: PgPool;
let directory: TenantDirectory;
let built: BuiltApp;
let baseline = 0;
const prepared: string[] = [];
let queries = 0;
let dueQueries = 0;
const query = pg.Client.prototype.query;

before(async () => {
  if (!URL_ADMIN) return;
  admin = new pg.Client({ connectionString: URL_ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  const password = randomBytes(12).toString("hex");
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  const url = new URL(URL_ADMIN);
  url.username = ROLE;
  url.password = password;
  url.pathname = `/${DB}`;
  databaseUrl = url.toString();
  const config = testConfig({ databaseUrl, multitenant: true, dataDir: mkdtempSync(join(tmpdir(), "lazy-")) });
  built = stopAtEnd(buildApp({ anthropicApiKey: "test-anthropic-key", ...config }, { harness: createMockHarness() }));
  await migrateRegisteredPgSchemas(databaseUrl);
  rls = createPgPool(databaseUrl);
  await rls.query(
    `INSERT INTO tenants(id, slug, org_id, hosts)
     SELECT gen_random_uuid(), 't' || i, 'org-' || i, ARRAY['t' || i || '.example.test'] FROM generate_series(1, $1) i`,
    [TENANTS],
  );
  await built.start();
  baseline = cachedTenantCount();
  directory = createTenantDirectory({
    databaseUrl,
    pool: rls,
    secretsKey: undefined,
    home: tenant(),
    homeHosts: ["home.example.test"],
    homeSandboxPrefix: "qm",
    prepare: () => {
      if (tenant().id) prepared.push(tenant().id!);
      return built.start();
    },
  });
  useTenantDirectory(directory);
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    queries++;
    const text = args[0] as string | { text?: string };
    if (String(typeof text === "string" ? text : text?.text).includes("FROM tenants WHERE status = 'active') t"))
      dueQueries++;
    return (query as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof query;
});

after(async () => {
  if (!URL_ADMIN) return;
  pg.Client.prototype.query = query;
  useTenantDirectory(undefined);
  await directory?.close();
  await built?.jobs.stop();
  await rls?.close();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test("loading 2,000 tenants prepares none of them and caches nothing for them", { skip }, async () => {
  assert.equal((await directory.active()).length, TENANTS + 1);
  assert.deepEqual(prepared, []);
  assert.equal(cachedTenantCount(), baseline);
});

test(
  "every periodic job ticks with one query across all 2,000 tenants and runs nothing for idle ones",
  { skip },
  async () => {
    const before = { queries, dueQueries };
    await built.jobs.start();
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await built.jobs.stopClaims();
    const ticks = dueQueries - before.dueQueries;
    assert.ok(ticks >= 10, `the periodic jobs ticked (${ticks} due queries)`);
    assert.ok(queries - before.queries < TENANTS, `${queries - before.queries} queries stays far below one per tenant`);
    assert.deepEqual(prepared, []);
    assert.equal(cachedTenantCount(), baseline);
  },
);

test("a periodic job runs only in tenants with work, and only those tenants grow the cache", { skip }, async () => {
  const busy = (await directory.active()).filter((t) => t.id).slice(0, 3);
  const pool = createPgPool(databaseUrl);
  for (const t of busy)
    await withTenant(t, () => pool.q("INSERT INTO web_ui_state(id, value, updated_at) VALUES ('probe', '{}', 0)"));
  await pool.close();
  const jobs = createJobWorker(databaseUrl);
  const visited: Array<string | undefined> = [];
  jobs.every("lazy-probe", 60_000, () => visited.push(tenant().id), { due: hasRows("web_ui_state") });
  const before = { queries, dueQueries };
  await jobs.start();
  try {
    await settle(() => visited.length === busy.length);
  } finally {
    await jobs.stop();
  }
  assert.deepEqual(visited.toSorted(), busy.map((t: Tenant) => t.id).toSorted());
  assert.equal(dueQueries - before.dueQueries, 1);
  assert.ok(queries - before.queries < 300, `${queries - before.queries} queries for one tick`);
  assert.deepEqual(prepared.toSorted(), busy.map((t) => t.id!).toSorted());
  assert.equal(cachedTenantCount(), baseline + busy.length);
  const touched = (await directory.active()).filter((t) => t.id)[10]!;
  assert.equal((await directory.byHost(`${touched.slug}.example.test`))?.id, touched.id);
  assert.equal(cachedTenantCount(), baseline + busy.length + 1);
});

test("an idle tenant's cached state is dropped and disposed in its tenant, while a held tenant keeps its own", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const disposed: Array<string | undefined> = [];
  const state = perTenant(
    () => ({ id: tenant().id }),
    (s) => disposed.push(`${s.id}:${tenant().id}`),
  );
  const idle = tenantFor("idle-org", "11111111-0000-4000-8000-000000000001", "idle");
  const busy = tenantFor("busy-org", "11111111-0000-4000-8000-000000000002", "busy");
  const first = withTenant(idle, state);
  const release = holdTenant(busy);
  const kept = withTenant(busy, state);
  t.mock.timers.tick(31 * 60_000);
  withTenant(tenantFor("other-org", "11111111-0000-4000-8000-000000000003", "other"), state);
  assert.notEqual(withTenant(idle, state), first);
  assert.equal(withTenant(busy, state), kept);
  release();
  return new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
    assert.deepEqual(disposed, [`${idle.id}:${idle.id}`]),
  );
});
