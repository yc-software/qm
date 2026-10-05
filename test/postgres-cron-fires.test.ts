import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { scopeId, type Cron } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron fire table tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS cron_fires, fire_test_crons, durable_map_versions CASCADE");
  await p.end();
});

const base = { action: "x", owner: "U1", createdBy: "U1", ownerScopeId: scopeId("personal", "U1") };

test("pg cron_fires: an upsert keyed (cron_id, fire_key) carries a fire from running to ended", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  await fires.record("c1", { fireKey: "k1", threadRef: "t1", firedAt: 1_000, scheduledAt: 900, status: "running" });
  let { runs, total } = await fires.listByCron("c1");
  assert.equal(total, 1);
  assert.deepEqual(runs[0], { fireKey: "k1", threadRef: "t1", firedAt: 1_000, scheduledAt: 900, status: "running" });
  await fires.record("c1", {
    fireKey: "k1",
    threadRef: "t1",
    firedAt: 1_000,
    endedAt: 5_000,
    status: "ok",
    reply: "done",
    sessionId: "s1",
  });
  ({ runs, total } = await fires.listByCron("c1"));
  assert.equal(total, 1);
  assert.deepEqual(runs[0], {
    fireKey: "k1",
    threadRef: "t1",
    firedAt: 1_000,
    endedAt: 5_000,
    status: "ok",
    reply: "done",
    sessionId: "s1",
  });
});

test("pg cron_fires: a retried fireKey replaces its terminal row wholesale, shedding endedAt", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  await fires.record("c-retry", { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "failed" });
  await fires.record("c-retry", { fireKey: "k1", threadRef: "t1", firedAt: 3_000, status: "running" });
  const { runs } = await fires.listByCron("c-retry");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "running");
  assert.equal(runs[0]!.firedAt, 3_000);
  assert.equal(runs[0]!.endedAt, undefined);
});

test("pg cron_fires: listByCron pages the latest N with the full total", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  for (const [key, at] of [
    ["k1", 1_000],
    ["k3", 3_000],
    ["k2", 2_000],
  ] as const) {
    await fires.record("c-page", { fireKey: key, threadRef: `t-${key}`, firedAt: at, endedAt: at + 1, status: "ok" });
  }
  const { runs, total } = await fires.listByCron("c-page", { limit: 2 });
  assert.equal(total, 3);
  assert.deepEqual(
    runs.map((r) => r.fireKey),
    ["k2", "k3"],
  );
});

test("pg cron_fires: thread-ref lookups hit the indexed columns across crons", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  await fires.record("c-a", {
    fireKey: "ka",
    threadRef: "thread-a",
    firedAt: 1_000,
    endedAt: 2_000,
    status: "ok",
    reply: "ra",
  });
  await fires.record("c-b", {
    fireKey: "kb",
    threadRef: "thread-b",
    firedAt: 3_000,
    endedAt: 4_000,
    status: "ok",
    note: "nb",
  });
  await fires.record("c-b", { fireKey: "kb2", threadRef: "thread-b", firedAt: 5_000, status: "running" });
  const records = await fires.listByThreadRefs(["thread-a", "thread-b", "missing"]);
  assert.deepEqual(
    records.map((r) => [r.cronId, r.fireKey]),
    [
      ["c-a", "ka"],
      ["c-b", "kb"],
      ["c-b", "kb2"],
    ],
  );
  assert.equal((await fires.latestForThread("c-b", "thread-b"))?.fireKey, "kb2");
  assert.equal(await fires.latestForThread("c-b", "missing"), undefined);
  assert.deepEqual(await fires.listByThreadRefs([]), []);
});

test("pg cron_fires: fire rows accept text a legacy jsonb blob would reject (NULs stripped)", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  await fires.record("c-nul", {
    fireKey: "k1",
    threadRef: "t1",
    firedAt: 1_000,
    endedAt: 2_000,
    status: "failed",
    note: "boom\u0000boom",
  });
  assert.equal((await fires.listByCron("c-nul")).runs[0]!.note, "boomboom");
});

test("pg cron_fires: the cron store writes the table only and reads back through it", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  const backing = createPostgresMapFactory(URL!).map<Cron>("fire_test_crons");
  const store = createCronStore(backing, { fires });
  const cron = await store.create({ ...base, schedule: { everyMs: 60_000 } });
  await store.beginFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" });
  await store.recordFire(cron.id, { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 2_000, status: "ok" });
  const { runs, total } = await store.listFires(cron.id);
  assert.equal(total, 1);
  assert.equal(runs[0]!.status, "ok");
  await store.delete(cron.id);
  assert.equal((await store.listFires(cron.id)).total, 1, "fires outlive the deleted cron");
});

test(
  "pg cron_fires: beginExclusive is a real CAS — refused while live, allowed after end or staleness",
  { skip },
  async () => {
    const fires = createPostgresCronFireStore(URL!);
    const first = await fires.beginExclusive(
      "c-excl",
      { fireKey: "k1", threadRef: "t1", firedAt: 1_000, status: "running" },
      10_000,
    );
    assert.deepEqual(first, { begun: true });
    const refused = await fires.beginExclusive(
      "c-excl",
      { fireKey: "k2", threadRef: "t2", firedAt: 2_000, status: "running" },
      10_000,
    );
    assert.equal(refused.begun, false);
    assert.equal(refused.begun ? "" : refused.running?.fireKey, "k1");
    assert.equal((await fires.listByCron("c-excl")).total, 1, "a refused begin journals nothing");
    await fires.record("c-excl", { fireKey: "k1", threadRef: "t1", firedAt: 1_000, endedAt: 3_000, status: "ok" });
    const afterEnd = await fires.beginExclusive(
      "c-excl",
      { fireKey: "k3", threadRef: "t3", firedAt: 4_000, status: "running" },
      10_000,
    );
    assert.equal(afterEnd.begun, true);
    const afterStale = await fires.beginExclusive(
      "c-excl",
      { fireKey: "k4", threadRef: "t4", firedAt: 14_001, status: "running" },
      10_000,
    );
    assert.equal(afterStale.begun, true, "a crashed running row stops blocking once stale");
  },
);

test("pg cron_fires: concurrent beginExclusive calls admit exactly one fire", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  const results = await Promise.all(
    Array.from({ length: 5 }, (_v, i) =>
      fires.beginExclusive(
        "c-race",
        { fireKey: `k${i}`, threadRef: `t${i}`, firedAt: 1_000 + i, status: "running" },
        60_000,
      ),
    ),
  );
  assert.equal(results.filter((r) => r.begun).length, 1, "the advisory lock serializes the check-then-insert");
  assert.equal((await fires.listByCron("c-race")).total, 1);
});

test("pg cron_fires: sweepStranded closes only over-age running rows and reports the count", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  await fires.record("c-sweep", { fireKey: "old", threadRef: "t1", firedAt: 1_000, status: "running" });
  await fires.record("c-sweep", { fireKey: "live", threadRef: "t2", firedAt: 8_000, status: "running" });
  await fires.record("c-sweep", { fireKey: "done", threadRef: "t3", firedAt: 2_000, endedAt: 2_500, status: "ok" });
  const swept = await fires.sweepStranded(12_000, 10_000, "stranded");
  assert.ok(swept >= 1, "the sweep is global to the table, so other tests' strays may add to the count");
  const { runs } = await fires.listByCron("c-sweep");
  const old = runs.find((r) => r.fireKey === "old")!;
  assert.equal(old.status, "failed");
  assert.equal(old.endedAt, 12_000);
  assert.equal(old.note, "stranded");
  assert.equal(runs.find((r) => r.fireKey === "live")!.status, "running");
  assert.equal(runs.find((r) => r.fireKey === "done")!.status, "ok");
  assert.equal(await fires.sweepStranded(12_000, 10_000, "stranded"), 0, "a second sweep finds nothing");
});

test("pg cron_fires: pruneEnded respects the keep window, the age cutoff, and running rows", { skip }, async () => {
  const fires = createPostgresCronFireStore(URL!);
  await fires.record("c-gc", { fireKey: "k1", threadRef: "t1", firedAt: 1, endedAt: 10, status: "ok" });
  await fires.record("c-gc", { fireKey: "k2", threadRef: "t2", firedAt: 2, endedAt: 20, status: "failed" });
  await fires.record("c-gc", { fireKey: "k3", threadRef: "t3", firedAt: 3, endedAt: 30, status: "ok" });
  await fires.record("c-gc", { fireKey: "k4", threadRef: "t4", firedAt: 4, status: "running" });
  await fires.record("c-gc", { fireKey: "k5", threadRef: "t5", firedAt: 5, endedAt: 24, status: "ok" });
  assert.equal(await fires.pruneEnded({ endedBefore: 25, keepPerCron: 2 }), 2);
  assert.deepEqual(
    (await fires.listByCron("c-gc")).runs.map((r) => r.fireKey),
    ["k3", "k4", "k5"],
  );
  assert.equal(
    await fires.pruneEnded({ endedBefore: 25, keepPerCron: 2 }),
    0,
    "k3 outlived the cutoff; nothing else qualifies",
  );
});

test(
  "pg cron history retirement verifies then imports without regressing canonical completions",
  { skip },
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = () =>
      promisify(execFile)(process.execPath, ["scripts/retire-cron-fire-history.ts"], { env: process.env });
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL! });
    const fires = createPostgresCronFireStore(URL!);
    const ended = {
      fireKey: "kept",
      threadRef: "t",
      firedAt: 1000,
      endedAt: 2000,
      status: "ok" as const,
      reply: "new",
    };
    try {
      await fires.record("retirement", ended);
      await p.query("CREATE TABLE crons (id text PRIMARY KEY, json jsonb NOT NULL)");
      await p.query("INSERT INTO crons VALUES ('retirement', $1)", [
        {
          fireLog: [
            { fireKey: "kept", threadRef: "t", firedAt: 1000, status: "ok", reply: "old" },
            { fireKey: "missing", threadRef: "t", firedAt: 3000, status: "running" },
          ],
        },
      ]);
      await p.query("CREATE TABLE cron_fire_log (cron_id text, fire_key text, fired_at bigint, json jsonb)");
      await p.query("INSERT INTO cron_fire_log VALUES ('retirement', 'table', 4000, $1)", [
        { threadRef: "t", status: "ok" },
      ]);
      await assert.rejects(run(), (error: unknown) => {
        assert.match((error as { stdout: string }).stdout, /"missing":2/);
        return true;
      });
      assert.equal((await p.query("SELECT json ? 'fireLog' AS present FROM crons")).rows[0].present, true);
      await promisify(execFile)(process.execPath, ["scripts/retire-cron-fire-history.ts", "--apply"], {
        env: process.env,
      });
      assert.match((await run()).stdout, /"missing":0/);
      const { runs } = await fires.listByCron("retirement");
      assert.equal(runs.length, 3);
      assert.deepEqual(
        runs.find((r) => r.fireKey === "kept"),
        ended,
      );
      assert.equal(runs.find((r) => r.fireKey === "table")?.endedAt, 4000);
      assert.equal((await p.query("SELECT json ? 'fireLog' AS present FROM crons")).rows[0].present, false);
    } finally {
      await p.query("DROP TABLE IF EXISTS crons, cron_fire_log");
      await p.end();
    }
  },
);
