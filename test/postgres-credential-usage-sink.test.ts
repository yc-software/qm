import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresCredentialUsageSink } from "../src/admin/postgres-credential-usage-sink.ts";
import { scopeId } from "../src/types.ts";
import { settle } from "./support/settle.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres credential-usage tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS credential_usage CASCADE");
  await p.end();
});

test(
  "pg credential-usage sink: persists broker calls, filters by scope/slug/since, newest-first",
  { skip },
  async (t) => {
    const sink = createPostgresCredentialUsageSink(URL!);
    const s1 = scopeId("personal", "U1");
    const s2 = scopeId("personal", "U2");

    const now = Date.now();
    const clock = t.mock.method(Date, "now", () => now);
    sink.record({
      slug: "x-firehose",
      host: "api.x.com",
      status: "ok",
      upstreamStatus: 200,
      scopeLabel: s1,
      principalId: "U1",
    });
    clock.mock.mockImplementation(() => now + 1);
    sink.record({ slug: "serp", host: "serpapi.com", status: "denied", scopeLabel: s2, principalId: "U2" });
    clock.mock.restore();
    await settle(async () => (await sink.list({ limit: 100 })).length === 2);

    const all = await sink.list({ limit: 100 });
    assert.equal(all.length, 2, "both brokered calls persisted");
    assert.equal(all[0]!.ts, now + 1);
    assert.equal(all[1]!.ts, now);
    assert.equal(all[0]!.scopeLabel, s2, "newest first");
    assert.equal(all[0]!.status, "denied");
    assert.equal(all[0]!.upstreamStatus, undefined, "an absent upstream status stays absent (not 0)");

    const onlyS1 = await sink.list({ scopeId: s1, limit: 100 });
    assert.equal(onlyS1.length, 1, "scope filter narrows to one");
    assert.equal(onlyS1[0]!.host, "api.x.com");
    assert.equal(onlyS1[0]!.slug, "x-firehose");
    assert.equal(onlyS1[0]!.upstreamStatus, 200, "captured upstream status round-trips");
    assert.equal(onlyS1[0]!.principalId, "U1");

    const onlySlug = await sink.list({ slug: "serp", limit: 100 });
    assert.equal(onlySlug.length, 1, "slug filter narrows to one");
    assert.equal(onlySlug[0]!.scopeLabel, s2);

    const future = await sink.list({ since: Date.now() + 60_000, limit: 100 });
    assert.equal(future.length, 0, "nothing at/after a future cutoff");
  },
);

test("pg credential-usage sink: survives a fresh sink over the same table (durability)", { skip }, async () => {
  const reopened = createPostgresCredentialUsageSink(URL!);
  const rows = await reopened.list({ limit: 100 });
  assert.ok(rows.length >= 2, "calls written by a prior sink instance are still readable");
});

test("pg credential-usage sink: sparse and absent credentials use an ordered index", { skip }, async () => {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    await p.query(`INSERT INTO credential_usage(ts, slug, host, status, scope_label, principal_id)
      SELECT n, 'unrelated-' || n, 'example.com', 'ok', 'personal:other', 'other'
      FROM generate_series(1, 20000) n`);
    await p.query("ANALYZE credential_usage");
    for (const slug of ["serp", "missing-credential"]) {
      const result = await p.query(
        "EXPLAIN (ANALYZE, FORMAT JSON) SELECT ts, slug, host, status, upstream_status, scope_label, principal_id FROM credential_usage WHERE slug = $1 ORDER BY ts DESC, id DESC LIMIT 20",
        [slug],
      );
      const plan = result.rows[0]["QUERY PLAN"][0].Plan;
      const scan = plan.Plans[0];
      assert.equal(scan["Node Type"], "Index Scan");
      assert.equal(scan["Index Name"], "credential_usage_by_slug_ts_id");
      assert.equal(scan["Rows Removed by Filter"] ?? 0, 0);
    }
  } finally {
    await p.end();
  }
});

test("pg credential summaries aggregate a bounded window without transferring raw events", { skip }, async (t) => {
  const { createCredentialUsageSink, CREDENTIAL_USAGE_WINDOW } = await import("../src/admin/credential-usage-sink.ts");
  const memory = createCredentialUsageSink();
  const sink = createPostgresCredentialUsageSink(URL!);
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  t.after(() => pool.end());
  await pool.query(
    `INSERT INTO credential_usage(ts, slug, host, status, scope_label, principal_id)
    SELECT n, 'summary-window', 'example.com', CASE WHEN n % 3 = 0 THEN 'denied' ELSE 'ok' END,
      'personal:summary', 'person-' || (n % 20) FROM generate_series(1, $1::int) n`,
    [CREDENTIAL_USAGE_WINDOW + 10],
  );
  const clock = t.mock.method(Date, "now");
  for (let n = 1; n <= CREDENTIAL_USAGE_WINDOW + 10; n++) {
    clock.mock.mockImplementation(() => n);
    memory.record({
      slug: "summary-window",
      host: "example.com",
      status: n % 3 === 0 ? "denied" : "ok",
      scopeLabel: "personal:summary",
      principalId: "person-" + (n % 20),
    });
  }
  clock.mock.restore();
  const slugs = ["summary-window", "summary-absent", "summary-window"];
  assert.deepEqual(await sink.summary(slugs), await memory.summary(slugs));
  await pool.query(`INSERT INTO credential_usage(ts, slug, host, status, scope_label, principal_id)
    SELECT 123, 'summary-ties', 'example.com', 'ok', 'personal:summary', 'person-' || n
    FROM generate_series(1, 20) n`);
  const tiedClock = t.mock.method(Date, "now", () => 123);
  for (let n = 1; n <= 20; n++) {
    memory.record({
      slug: "summary-ties",
      host: "example.com",
      status: "ok",
      scopeLabel: "personal:summary",
      principalId: "person-" + n,
    });
  }
  tiedClock.mock.restore();
  assert.deepEqual(await sink.summary(["summary-ties"]), await memory.summary(["summary-ties"]));
  assert.deepEqual(await sink.summary([]), []);
  assert.equal((await sink.summary(["serp"]))[0]!.usageCount, 0);
});

test("pg credential summaries do not wait for pending telemetry writes", { skip }, async (t) => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  const locker = await pool.connect();
  const sink = createPostgresCredentialUsageSink(URL!);
  await sink.summary(["summary-blocked"]);
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE credential_usage IN SHARE MODE");
  t.after(async () => {
    await locker.query("ROLLBACK");
    locker.release();
    await sink.list({ slug: "summary-blocked" });
    await pool.end();
  });
  sink.record({
    slug: "summary-blocked",
    host: "example.com",
    status: "ok",
    scopeLabel: "personal:summary",
    principalId: "summary",
  });
  const result = await Promise.race([
    sink.summary(["summary-blocked"]),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("summary waited for blocked write")), 2000);
      timer.unref();
    }),
  ]);
  assert.equal(result[0]!.usageCount, 0);
});
