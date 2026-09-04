import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createPostgresCronFireStore } from "../src/cron/cron-fire-store.ts";
import { scopeId, type Cron } from "../src/types.ts";
import {
  createKeychain,
  KeychainError,
  type KeychainAsk,
  type KeychainCredential,
  type KeychainGrant,
} from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres map tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS map_widgets, map_crons, map_cron_fires, map_keychain_creds, map_keychain_grants, map_keychain_asks, process_sessions, durable_map_versions CASCADE",
  );
  await p.end();
});

interface Widget {
  name: string;
  tags: string[];
  nested: { n: number };
}

test("pg map: put/get/all/upsert/delete with a JSONB value round-trip", { skip }, async () => {
  const m = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
  assert.deepEqual(await m.all(), []);
  assert.equal(await m.get("a"), null);

  const w: Widget = { name: "a", tags: ["x", "y"], nested: { n: 1 } };
  await m.put("a", w);
  assert.deepEqual(await m.get("a"), w, "value round-trips through JSONB intact");
  assert.equal((await m.all()).length, 1);

  await m.put("a", { ...w, name: "a2" });
  assert.equal((await m.all()).length, 1);
  assert.equal((await m.get("a"))!.name, "a2");

  await m.put("b", { name: "b", tags: [], nested: { n: 2 } });
  assert.equal((await m.all()).length, 2);

  await m.delete("a");
  assert.equal(await m.get("a"), null);
  assert.deepEqual(
    (await m.all()).map((x) => x.name),
    ["b"],
  );

  assert.equal((await m.take("b"))!.name, "b");
  assert.equal(await m.take("b"), null, "second take sees nothing (row already claimed)");
  assert.deepEqual(await m.all(), []);
});

test("pg map: a value persists across map instances (no per-process cache to diverge)", { skip }, async () => {
  const writer = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
  await writer.put("shared", { name: "shared", tags: ["s"], nested: { n: 9 } });
  const reader = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
  assert.equal((await reader.get("shared"))!.nested.n, 9);
});

test("pg map: an artifact store rides the map (a cron round-trips through Postgres)", { skip }, async () => {
  const writer = createPostgresMapFactory(URL!);
  const store = createCronStore(
    writer.map<Cron>("map_crons"),
    createPostgresCronFireStore(writer.pool, "map_crons", "map_cron_fires"),
  );
  const c = await store.create({
    schedule: { everyMs: 60_000 },
    action: "digest",
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
  });
  await store.markFired(c.id, 123);
  await store.recordFire(c.id, { fireKey: "f1", threadRef: "cron:f1", firedAt: 123, reply: "done" });
  await store.recordFire(c.id, { fireKey: "f2", threadRef: "cron:f2", firedAt: 124 });
  await store.recordFire(c.id, { fireKey: "f3", threadRef: "cron:f3", firedAt: 125 });
  const factory = createPostgresMapFactory(URL!);
  const reader = createCronStore(
    factory.map<Cron>("map_crons"),
    createPostgresCronFireStore(factory.pool, "map_crons", "map_cron_fires"),
  );
  const got = await reader.get(c.id);
  assert.equal(got?.action, "digest");
  assert.equal(got?.lastFiredAt, 123);
  assert.deepEqual(await reader.getRuns(c.id, 2), {
    runs: [
      { fireKey: "f2", threadRef: "cron:f2", firedAt: 124 },
      { fireKey: "f3", threadRef: "cron:f3", firedAt: 125 },
    ],
    total: 3,
  });
});

test("pg cron store migrates inline fire history without loading it in cron scans", { skip }, async () => {
  const factory = createPostgresMapFactory(URL!);
  const backing = factory.map<Cron>("map_crons");
  await backing.put("legacy", {
    id: "legacy",
    schedule: { firstFireAt: 1 },
    enabled: true,
    createdAt: 0,
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
    fireLog: [{ fireKey: "legacy-fire", threadRef: "cron:legacy:fire", firedAt: 1, reply: "kept" }],
  });
  const store = createCronStore(backing, createPostgresCronFireStore(factory.pool, "map_crons", "map_cron_fires"));

  assert.equal((await store.list())[0]?.fireLog, undefined);
  assert.equal((await backing.get("legacy"))?.fireLog, undefined);
  assert.deepEqual(await store.getRuns("legacy"), {
    runs: [{ fireKey: "legacy-fire", threadRef: "cron:legacy:fire", firedAt: 1, reply: "kept" }],
    total: 1,
  });
});

test("pg cron migration preserves fires written by an old worker during rollout", { skip }, async () => {
  const factory = createPostgresMapFactory(URL!);
  const backing = factory.map<Cron>("map_crons");
  await backing.put("rolling", {
    id: "rolling",
    schedule: { firstFireAt: 1 },
    enabled: true,
    createdAt: 0,
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
    fireLog: [{ fireKey: "before", threadRef: "cron:rolling:before", firedAt: 1 }],
  });
  const store = createCronStore(backing, createPostgresCronFireStore(factory.pool, "map_crons", "map_cron_fires"));
  const client = await (await factory.pool.pool()).connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT json FROM map_crons WHERE id = $1 FOR UPDATE", ["rolling"]);
    const json = locked.rows[0]!.json as Cron;
    json.fireLog!.push({ fireKey: "during", threadRef: "cron:rolling:during", firedAt: 2 });
    const migration = store.due(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.query("UPDATE map_crons SET json = $2 WHERE id = $1", ["rolling", json]);
    await client.query("COMMIT");
    assert.equal((await migration)[0]?.fireLog, undefined);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }

  await backing.merge("rolling", {
    fireLog: [{ fireKey: "after", threadRef: "cron:rolling:after", firedAt: 3 }],
  });
  assert.equal((await store.due(1))[0]?.fireLog, undefined);
  assert.equal((await backing.get("rolling"))?.fireLog, undefined);
  assert.deepEqual(
    (await store.getRuns("rolling")).runs.map((run) => run.fireKey),
    ["before", "during", "after"],
  );
});

test(
  "pg map: putIfAbsent inserts once and returns the existing row on a conflict (atomic claim)",
  { skip },
  async () => {
    const m = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
    const first: Widget = { name: "first", tags: ["a"], nested: { n: 1 } };
    const won = await m.putIfAbsent("dedupe", first);
    assert.deepEqual(won, first, "the first writer's value is stored and returned");
    const lost = await m.putIfAbsent("dedupe", { name: "second", tags: ["b"], nested: { n: 2 } });
    assert.deepEqual(lost, first, "the loser sees the canonical pre-existing row, not its own value");
    assert.equal((await m.get("dedupe"))!.name, "first", "the stored row was never clobbered");
  },
);

test("pg map: rejects an unsafe table name (the DDL/DML interpolation guard)", () => {
  const factory = createPostgresMapFactory("postgres://unused");
  assert.throws(() => factory.map("bad name"), /invalid table name/);
  assert.throws(() => factory.map("crons;--"), /invalid table name/);
});

test(
  "pg map: merge does field-level updates (sets fields, removes undefined keys, null when absent)",
  { skip },
  async () => {
    const m = createPostgresMapFactory(URL!).map<Widget & { note?: string }>("map_widgets");
    await m.put("mw", { name: "mw", tags: ["a"], nested: { n: 1 }, note: "hi" });
    const merged = await m.merge("mw", { name: "mw2", note: undefined });
    assert.equal(merged?.name, "mw2");
    assert.deepEqual(merged?.tags, ["a"], "untouched fields survive the merge");
    assert.equal("note" in (merged ?? {}), false, "an explicitly-undefined key is removed");
    assert.deepEqual(await m.get("mw"), merged);
    assert.equal(await m.merge("missing", { name: "x" }), null);
  },
);

test("pg map: all()/entries() stay coherent across instances despite the read cache", { skip }, async () => {
  const writer = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
  const reader = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
  await writer.put("c1", { name: "c1", tags: [], nested: { n: 1 } });
  assert.deepEqual(
    (await reader.all()).map((w) => w.name).filter((n) => n === "c1"),
    ["c1"],
  );
  await reader.all();
  await writer.put("c2", { name: "c2", tags: [], nested: { n: 2 } });
  assert.ok(
    (await reader.all()).some((w) => w.name === "c2"),
    "put through another instance is visible",
  );
  await writer.merge("c2", { name: "c2m" });
  assert.ok(
    (await reader.entries()).some(([id, w]) => id === "c2" && w.name === "c2m"),
    "merge is visible",
  );
  await writer.update!("c2", (w) => ({ ...w, nested: { n: 9 } }));
  assert.equal((await reader.all()).find((w) => w.name === "c2m")?.nested.n, 9, "update is visible");
  await writer.delete("c2");
  assert.ok(!(await reader.all()).some((w) => w.name?.startsWith("c2")), "delete is visible");
  await writer.take("c1");
  assert.ok(!(await reader.entries()).some(([id]) => id === "c1"), "take is visible");
});

test("pg map: a caller mutating an all() result cannot poison the cache", { skip }, async () => {
  const m = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
  await m.put("mut", { name: "mut", tags: ["a"], nested: { n: 1 } });
  const first = (await m.all()).find((w) => w.name === "mut")!;
  first.tags.push("EVIL");
  first.nested.n = 999;
  const again = (await m.all()).find((w) => w.name === "mut")!;
  assert.deepEqual(again.tags, ["a"]);
  assert.equal(again.nested.n, 1);
});

test("pg map: update transforms a row under a lock", { skip }, async () => {
  const m = createPostgresMapFactory(URL!).map<Widget>("map_widgets");
  await m.put("upd", { name: "upd", tags: [], nested: { n: 0 } });
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      m.update!("upd", (w) => ({ ...w, tags: [...w.tags, String(i)], nested: { n: w.nested.n + 1 } })),
    ),
  );
  const after = await m.get("upd");
  assert.equal(after?.nested.n, 5);
  assert.equal(after?.tags.length, 5);
});

test("pg map: concurrent keychain instances claim a once grant exactly once", { skip }, async () => {
  const first = createPostgresMapFactory(URL!);
  const second = createPostgresMapFactory(URL!);
  const key = deriveConnectorKey("postgres-keychain-test-key");
  const build = (factory: ReturnType<typeof createPostgresMapFactory>) =>
    createKeychain({
      creds: factory.map<KeychainCredential>("map_keychain_creds"),
      grants: factory.map<KeychainGrant>("map_keychain_grants"),
      asks: factory.map<KeychainAsk>("map_keychain_asks"),
      key,
    });
  const owner = build(first);
  const peer = build(second);
  try {
    const credential = await owner.save({
      ownerId: "U1",
      service: "github",
      secret: "ghp_secret",
      envKey: "GITHUB_TOKEN",
    });
    const grant = await owner.createGrant({
      credentialId: credential.id,
      ownerId: "U1",
      audienceScopeId: scopeId("channel", "C1"),
      mode: "once",
      purpose: "single use",
    });
    const results = await Promise.allSettled([
      owner.materialize(grant.id, scopeId("channel", "C1"), "U2"),
      peer.materialize(grant.id, scopeId("channel", "C1"), "U3"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      results.filter(
        (result) =>
          result.status === "rejected" && result.reason instanceof KeychainError && result.reason.status === 410,
      ).length,
      1,
    );
  } finally {
    await first.pool.close();
    await second.pool.close();
  }
});
