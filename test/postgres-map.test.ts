import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
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
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query(
    "DROP TABLE IF EXISTS map_widgets, map_crons, map_keychain_creds, map_keychain_grants, map_keychain_asks, process_sessions, durable_map_versions CASCADE",
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
  const store = createCronStore(createPostgresMapFactory(URL!).map<Cron>("map_crons"));
  const c = await store.create({
    schedule: { everyMs: 60_000 },
    action: "digest",
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
  });
  await store.markFired(c.id, 123);
  const reader = createCronStore(createPostgresMapFactory(URL!).map<Cron>("map_crons"));
  const got = await reader.get(c.id);
  assert.equal(got?.action, "digest");
  assert.equal(got?.lastFiredAt, 123);
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

test("pg map: select mirrors the memory map — folded field filter, projection, id order", { skip }, async () => {
  type Owned = Widget & { owner: string; secretEnc?: string };
  const rows: Array<[string, Owned]> = [
    ["sel-a", { name: "sel-a", tags: ["t"], nested: { n: 1 }, owner: "U7", secretEnc: "enc-a" }],
    ["sel-b", { name: "sel-b", tags: [], nested: { n: 2 }, owner: "u7", secretEnc: "enc-b" }],
    ["sel-c", { name: "sel-c", tags: [], nested: { n: 3 }, owner: "Someone@X.com", secretEnc: "enc-c" }],
  ];
  const factory = createPostgresMapFactory(URL!);
  const pgMap = factory.map<Owned>("map_widgets");
  const memMap = createMemoryMap<Owned>();
  for (const [id, row] of rows) {
    await pgMap.put(id, row);
    await memMap.put(id, row);
  }
  try {
    const mine = await pgMap.select({ omit: ["secretEnc"], where: { field: "owner", anyOfFold: ["U7"] } });
    assert.deepEqual(mine, await memMap.select({ omit: ["secretEnc"], where: { field: "owner", anyOfFold: ["U7"] } }));
    assert.deepEqual(
      mine.map((w) => w.name),
      ["sel-a", "sel-b"],
    );
    assert.ok(
      mine.every((w) => !("secretEnc" in w)),
      "the omitted key is gone from every row",
    );
    assert.deepEqual(mine[0]!.nested, { n: 1 }, "nested fields survive the projection");

    const email = await pgMap.select({ where: { field: "owner", anyOfFold: ["SOMEONE@x.com"] } });
    assert.deepEqual(email, await memMap.select({ where: { field: "owner", anyOfFold: ["SOMEONE@x.com"] } }));
    assert.equal(email[0]!.secretEnc, "enc-c", "without omit the full row comes back");

    assert.deepEqual(await pgMap.select({ where: { field: "owner", anyOfFold: [] } }), []);

    const turkish: Owned = { name: "sel-d", tags: [], nested: { n: 4 }, owner: "İstanbul@X.com", secretEnc: "enc-d" };
    await pgMap.put("sel-d", turkish);
    await memMap.put("sel-d", turkish);
    const swept = await pgMap.select({ where: { field: "owner", anyOfFold: ["no-such-owner"] } });
    assert.deepEqual(swept, await memMap.select({ where: { field: "owner", anyOfFold: ["no-such-owner"] } }));
    assert.deepEqual(
      swept.map((w) => w.name),
      ["sel-d"],
      "a non-ASCII field value is always a candidate — SQL lower() and JS toLowerCase() disagree there",
    );
  } finally {
    for (const id of [...rows.map(([id]) => id), "sel-d"]) await pgMap.delete(id);
    await factory.pool.close();
  }
});

test("pg keychain: listByOwner is a per-owner projected read with no secret material", { skip }, async () => {
  const factory = createPostgresMapFactory(URL!);
  const keychain = createKeychain({
    creds: factory.map<KeychainCredential>("map_keychain_creds"),
    grants: factory.map<KeychainGrant>("map_keychain_grants"),
    asks: factory.map<KeychainAsk>("map_keychain_asks"),
    key: deriveConnectorKey("postgres-keychain-test-key"),
  });
  try {
    await keychain.save({ ownerId: "Owner-A@X.com", service: "github", secret: "ghp_a", envKey: "GITHUB_TOKEN" });
    await keychain.save({ ownerId: "U-other", service: "github", secret: "ghp_b", envKey: "GITHUB_TOKEN" });
    await keychain.save({ ownerId: "İstanbul@X.com", service: "gitlab", secret: "glpat_c", envKey: "GITLAB_TOKEN" });

    const turkish = await keychain.listByOwner("İstanbul@X.com");
    assert.equal(turkish.length, 1, "an owner id where SQL and JS case folding diverge still lists its credentials");
    assert.equal(turkish[0]!.service, "gitlab");

    const listed = await keychain.listByOwner("owner-a@x.COM");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.service, "github");
    assert.ok(!("secretEnc" in listed[0]!));
    assert.ok(!JSON.stringify(listed).includes("ghp_a"));

    const own = await keychain.materializeOwn("owner-a@x.com");
    assert.deepEqual(
      own.flatMap((m) => m.env),
      [{ key: "GITHUB_TOKEN", value: "ghp_a" }],
      "the owner's own materialization still decrypts the secret",
    );
  } finally {
    await factory.pool.close();
  }
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
