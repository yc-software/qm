import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, createPostgresMap } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import type { Cron } from "../src/types.ts";
import { scopeId } from "../src/types.ts";

test("crons persist to the backing map (a second store instance reads them back)", async () => {
  const map = createMemoryMap<Cron>();
  const s1 = createCronStore(map);
  const c = await s1.create({
    schedule: { everyMs: 60_000 },
    action: "summarize signups",
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
    destination: { type: "dm", target: "U1" },
  });
  await s1.markFired(c.id, 123);

  const s2 = createCronStore(map);
  const got = await s2.get(c.id);
  assert.equal(got?.action, "summarize signups");
  assert.equal(got?.lastFiredAt, 123);
});

test("skills persist AND verify with a stable signing secret across store instances", async () => {
  const map = createMemoryMap<Skill>();
  const secret = "stable-test-secret";
  const s1 = createSkillStore({ signingSecret: secret, backing: map });
  const sk = await s1.create({
    scopeId: scopeId("personal", "U1"),
    manifest: { name: "digest", description: "make a digest", requiredCapabilities: [], body: "..." },
    createdBy: "U1",
  });

  const s2 = createSkillStore({ signingSecret: secret, backing: map });
  const got = await s2.get(sk.id);
  assert.ok(got, "skill is readable through a second store instance");
  assert.equal(got!.manifest.name, "digest");
  assert.equal(s2.verify(got!), true);
});

test("skill mutations reject names that could escape or collide when materialized", async () => {
  const backing = createMemoryMap<Skill>();
  const skills = createSkillStore({ backing });
  const manifest = (name: string) => ({ name, description: "d", requiredCapabilities: [], body: "b" });
  for (const name of ["..", "foo/bar", "foo\\bar", "foo bar", ".hidden", "foo."]) {
    await assert.rejects(
      () => skills.create({ scopeId: scopeId("personal", "U1"), manifest: manifest(name), createdBy: "U1" }),
      /skill name must/,
    );
  }

  const legacy = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: manifest("safe-name"),
    createdBy: "U1",
  });
  await backing.merge(legacy.id, { manifest: manifest("foo/bar"), status: "reviewed" });
  await assert.rejects(() => skills.publish(legacy.id), /skill name must/);
  assert.equal(
    (await skills.visibleFor([scopeId("personal", "U1")])).length,
    0,
    "legacy unsafe records never reach materialization",
  );
});

test("deployments persist with immutable versions across store instances", async () => {
  const map = createMemoryMap<Deployment>();
  const s1 = createDeployStore(map);
  const d = await s1.create({
    ownerScopeId: scopeId("team", "T1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/1",
  });
  await s1.addVersion(d.id, { entrypoint: "node server.js --v2", snapshotDir: "/snap/2" });

  const s2 = createDeployStore(map);
  const got = await s2.get(d.id);
  assert.equal(got?.versions.length, 2);
  assert.equal(got?.currentVersion, 2);
  assert.equal((await s2.versionOf(d.id, 1))?.snapshotDir, "/snap/1");
});

test("a fresh in-memory map is the unchanged default (ephemeral, no durability required)", async () => {
  const s = createCronStore(createMemoryMap<Cron>());
  const c = await s.create({
    schedule: { everyMs: 1000 },
    action: "x",
    ownerScopeId: scopeId("personal", "U1"),
    owner: "U1",
    createdBy: "U1",
    destination: { type: "dm", target: "U1" },
  });
  assert.equal((await s.list()).length, 1);
  assert.equal((await s.get(c.id))?.action, "x");
});

test("map iteration is deterministic id order — metadata updates (recordUse-style merges) must not reorder", async () => {
  const map = createMemoryMap<{ name: string; lastUsedAt?: number }>();
  await map.put("b", { name: "beta" });
  await map.put("c", { name: "gamma" });
  await map.put("a", { name: "alpha" });
  await map.merge("b", { lastUsedAt: Date.now() });
  assert.deepEqual(
    (await map.all()).map((v) => v.name),
    ["alpha", "beta", "gamma"],
  );
  assert.deepEqual(
    (await map.entries()).map(([id]) => id),
    ["a", "b", "c"],
  );
});

interface SelectRow {
  id: string;
  owner: string;
  secretEnc?: string;
  nested: { keep: string };
}

test("memory map select filters case-insensitively on one field and strips omitted top-level keys", async () => {
  const map = createMemoryMap<SelectRow>();
  await map.put("b", { id: "b", owner: "U1", secretEnc: "enc-b", nested: { keep: "b" } });
  await map.put("a", { id: "a", owner: "u1", secretEnc: "enc-a", nested: { keep: "a" } });
  await map.put("c", { id: "c", owner: "Alice@X.com", secretEnc: "enc-c", nested: { keep: "c" } });

  const mine = await map.select({ omit: ["secretEnc"], where: { field: "owner", anyOfFold: ["U1"] } });
  assert.deepEqual(mine, [
    { id: "a", owner: "u1", nested: { keep: "a" } },
    { id: "b", owner: "U1", nested: { keep: "b" } },
  ]);

  const alice = await map.select({ where: { field: "owner", anyOfFold: ["alice@x.COM"] } });
  assert.equal(alice.length, 1);
  assert.equal(alice[0]!.secretEnc, "enc-c", "without omit the full value comes back");

  assert.deepEqual(await map.select({ where: { field: "owner", anyOfFold: [] } }), []);
  assert.equal((await map.select({})).length, 3, "no filter and no projection reads everything");
});

test("select sweeps non-ASCII field values into the candidate set — SQL and JS case folding disagree there, so the caller's exact refilter decides", async () => {
  const map = createMemoryMap<SelectRow>();
  await map.put("t", { id: "t", owner: "İstanbul@X.com", nested: { keep: "t" } });
  await map.put("u", { id: "u", owner: "U1", nested: { keep: "u" } });
  const candidates = await map.select({ where: { field: "owner", anyOfFold: ["no-such-owner"] } });
  assert.deepEqual(
    candidates.map((r) => r.id),
    ["t"],
    "a non-ASCII value is never silently dropped by the fold prefilter",
  );
});

test("memory map select returns clones — mutating a result cannot poison the store", async () => {
  const map = createMemoryMap<SelectRow>();
  await map.put("x", { id: "x", owner: "U1", nested: { keep: "x" } });
  const [row] = await map.select({ where: { field: "owner", anyOfFold: ["u1"] } });
  row!.nested.keep = "EVIL";
  assert.equal((await map.get("x"))!.nested.keep, "x");
});

test("the Postgres map select projects and filters inside SQL, never fetching the omitted key", async () => {
  const reads: Array<{ sql: string; params?: unknown[] }> = [];
  const pg = {
    query: async () => ({ rows: [] }),
    q: async (sql: string, params?: unknown[]) => {
      reads.push({ sql, params });
      return [];
    },
    registerMigration: () => {},
    migrate: async () => {},
  };
  const map = createPostgresMap<SelectRow>(pg as never, "select_probe");
  await map.select({ omit: ["secretEnc"], where: { field: "owner", anyOfFold: ["U1", "Alice@X.com"] } });
  assert.equal(reads.length, 1);
  assert.match(
    reads[0]!.sql,
    /^SELECT json - \$1::text\[\] AS json FROM select_probe WHERE lower\(json->>\$2\) = ANY\(\$3::text\[\]\) OR json->>\$2 ~ '\[\^\\x01-\\x7f\]' ORDER BY id$/,
  );
  assert.deepEqual(reads[0]!.params, [["secretEnc"], "owner", ["u1", "alice@x.com"]]);

  await map.select({});
  assert.match(reads[1]!.sql, /^SELECT json - \$1::text\[\] AS json FROM select_probe ORDER BY id$/);
  assert.deepEqual(reads[1]!.params, [[]]);
});

test("the Postgres map reads with ORDER BY id — heap order is not a contract", async () => {
  const selects: string[] = [];
  const pg = {
    query: async () => ({ rows: [] }),
    q: async (sql: string) => {
      selects.push(sql);
      return [];
    },
    registerMigration: () => {},
    migrate: async () => {},
  };
  const map = createPostgresMap<{ x: number }>(pg as never, "order_probe");
  await map.all();
  await map.entries();
  const rowReads = selects.filter((sql) => sql.includes("FROM order_probe"));
  assert.ok(rowReads.length > 0, "the map must actually read its table");
  for (const sql of rowReads) assert.match(sql, /ORDER BY id/);
});
