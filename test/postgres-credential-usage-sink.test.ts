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
  await p.query("DROP TABLE IF EXISTS credential_daily_calls CASCADE");
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

function windowSummary(
  slug: string,
  events: readonly { ts: number; status: string; principalId: string }[],
  window: number,
) {
  const recent = events
    .map((event, id) => ({ ...event, id }))
    .sort((x, y) => y.ts - x.ts || y.id - x.id)
    .slice(0, window);
  const ok = recent.filter((event) => event.status === "ok");
  const principals: string[] = [];
  for (const event of ok) if (!principals.includes(event.principalId)) principals.push(event.principalId);
  return {
    slug,
    usageCount: ok.length,
    usageTruncated: recent.length === window,
    usageSince: ok.length ? Math.min(...ok.map((event) => event.ts)) : null,
    lastUsedAt: ok.length ? Math.max(...ok.map((event) => event.ts)) : null,
    recentUsagePrincipals: principals.slice(0, 12),
  };
}

test("pg credential summaries aggregate a bounded window without transferring raw events", { skip }, async (t) => {
  const { CREDENTIAL_USAGE_WINDOW } = await import("../src/admin/credential-usage-sink.ts");
  const sink = createPostgresCredentialUsageSink(URL!);
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  t.after(() => pool.end());
  await pool.query(
    `INSERT INTO credential_usage(ts, slug, host, status, scope_label, principal_id)
    SELECT n, 'summary-window', 'example.com', CASE WHEN n % 3 = 0 THEN 'denied' ELSE 'ok' END,
      'personal:summary', 'person-' || (n % 20) FROM generate_series(1, $1::int) n ORDER BY n`,
    [CREDENTIAL_USAGE_WINDOW + 10],
  );
  const windowEvents = Array.from({ length: CREDENTIAL_USAGE_WINDOW + 10 }, (_, i) => ({
    ts: i + 1,
    status: (i + 1) % 3 === 0 ? "denied" : "ok",
    principalId: "person-" + ((i + 1) % 20),
  }));
  assert.deepEqual(await sink.summary(["summary-window", "summary-absent", "summary-window"]), [
    windowSummary("summary-window", windowEvents, CREDENTIAL_USAGE_WINDOW),
    windowSummary("summary-absent", [], CREDENTIAL_USAGE_WINDOW),
  ]);
  await pool.query(`INSERT INTO credential_usage(ts, slug, host, status, scope_label, principal_id)
    SELECT 123, 'summary-ties', 'example.com', 'ok', 'personal:summary', 'person-' || n
    FROM generate_series(1, 20) n ORDER BY n`);
  const tiedEvents = Array.from({ length: 20 }, (_, i) => ({
    ts: 123,
    status: "ok",
    principalId: "person-" + (i + 1),
  }));
  assert.deepEqual(await sink.summary(["summary-ties"]), [
    windowSummary("summary-ties", tiedEvents, CREDENTIAL_USAGE_WINDOW),
  ]);
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

test("pg credential-usage sink: every process shares one daily cap per credential", { skip }, async () => {
  const processes = [createPostgresCredentialUsageSink(URL!), createPostgresCredentialUsageSink(URL!)];
  const admitted = await Promise.all(
    Array.from({ length: 10 }, (_, i) => processes[i % 2]!.admitDailyCall("capped", 3)),
  );
  assert.equal(admitted.filter(Boolean).length, 3);
  assert.equal(await createPostgresCredentialUsageSink(URL!).admitDailyCall("capped", 3), false);
  assert.equal(await processes[0]!.admitDailyCall("capped", 4), true);
});
