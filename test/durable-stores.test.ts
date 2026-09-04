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

test("the Postgres map reads with ORDER BY id — heap order is not a contract", async () => {
  const selects: string[] = [];
  const pg = {
    query: async () => ({ rows: [] }),
    q: async (sql: string) => {
      selects.push(sql);
      return [];
    },
  };
  const map = createPostgresMap<{ x: number }>(pg as never, "order_probe");
  await map.all();
  await map.entries();
  const rowReads = selects.filter((sql) => sql.includes("FROM order_probe"));
  assert.ok(rowReads.length > 0, "the map must actually read its table");
  for (const sql of rowReads) assert.match(sql, /ORDER BY id/);
});
