import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;

function copyOnReadMap(): DurableMap<Deployment> {
  const inner = createMemoryMap<Deployment>();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    ...inner,
    async get(id) {
      const value = await inner.get(id);
      await tick();
      return value ? structuredClone(value) : null;
    },
    async put(id, value) {
      await tick();
      await inner.put(id, structuredClone(value));
    },
    merge: inner.merge,
    update(id, fn) {
      return inner.update!(id, (value) => structuredClone(fn(structuredClone(value))));
    },
  };
}

const backings: Array<[string, () => DurableMap<Deployment>, false | string]> = [
  ["copy-on-read", copyOnReadMap, false],
  [
    "postgres",
    () =>
      createPostgresMapFactory(URL!).map<Deployment>(`deploy_race_${Date.now()}_${Math.floor(Math.random() * 1e6)}`),
    URL ? false : "set DATABASE_URL to run against Postgres",
  ],
];

for (const [label, backing, skip] of backings) {
  test(`${label}: concurrent deployment field updates do not overwrite each other`, { skip }, async () => {
    const store = createDeployStore(backing());
    const d = await store.create({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node a.js",
      snapshotDir: "/tmp/x",
    });
    const endpoint = { host: "10.0.0.1", port: 8080 };
    await Promise.all([
      store.addVersion(d.id, { entrypoint: "node b.js", snapshotDir: "/tmp/y" }),
      store.setEndpoint(d.id, endpoint),
      store.setStatus(d.id, "running"),
      store.setDisplayName(d.id, "Shiny"),
      store.setDefaultAudience(d.id, { sourceScopeId: scopeId("channel", "C1"), granteeScopeIds: [], snapshotAt: 1 }),
    ]);
    const after = (await store.get(d.id))!;
    assert.equal(after.versions.length, 2, "the new version survives");
    assert.equal(after.currentVersion, 2);
    assert.deepEqual(after.endpoint, endpoint, "the endpoint survives");
    assert.equal(after.status, "running");
    assert.equal(after.displayName, "Shiny");
    assert.ok(after.defaultAudience, "the default audience survives");
  });
}
