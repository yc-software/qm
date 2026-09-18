import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresMapFactory, type PostgresArtifactMaps } from "../src/persistence/durable-map.ts";
import { createDeployStore, type Deployment, type DeployStore } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the deploy access tests";

async function raw(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    const res = await p.query(sql, params);
    return res.rows as Record<string, unknown>[];
  } finally {
    await p.end();
  }
}

before(async () => {
  if (!URL) return;
  await raw("DROP TABLE IF EXISTS deployment_access CASCADE");
  await raw("DROP TABLE IF EXISTS deployments CASCADE");
  await raw(
    "DELETE FROM qm_schema_migrations WHERE id LIKE 'deploy/access/%' OR id LIKE 'durable-map/deployments/%'",
  ).catch(() => {});
  await raw("DELETE FROM durable_map_versions WHERE tbl = 'deployments'").catch(() => {});
});

const factories: PostgresArtifactMaps[] = [];

after(async () => {
  await Promise.all(factories.map((factory) => factory.pool.close()));
});

function makeFactory(): PostgresArtifactMaps {
  const factory = createPostgresMapFactory(URL!);
  factories.push(factory);
  return factory;
}

function makeStore(opts: { touchDebounceMs?: number } = {}): { store: DeployStore; factory: PostgresArtifactMaps } {
  const factory = makeFactory();
  const store = createDeployStore({
    deployments: factory.map<Deployment>("deployments"),
    pg: factory.pool,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-pg-")) },
    ...opts,
  });
  return { store, factory };
}

const createInput = (name?: string) => ({
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  entrypoint: "node s.js",
  snapshotDir: "/snap",
  ...(name ? { name } : {}),
});

test("touch upserts deployment_access without rewriting the blob or bumping the map version", { skip }, async () => {
  const { store } = makeStore({ touchDebounceMs: 0 });
  const d = await store.create(createInput());
  const versionBefore = (await raw("SELECT v FROM durable_map_versions WHERE tbl = 'deployments'"))[0]!.v;

  await store.touch(d.id, 111);
  assert.equal((await store.get(d.id))!.lastAccessAt, 111);
  assert.equal((await store.list()).find((x) => x.id === d.id)!.lastAccessAt, 111);

  const blob = (await raw("SELECT json FROM deployments WHERE id = $1", [d.id]))[0]!.json as Deployment;
  assert.equal("lastAccessAt" in blob, false, "touch stays out of the jsonb blob");
  const versionAfter = (await raw("SELECT v FROM durable_map_versions WHERE tbl = 'deployments'"))[0]!.v;
  assert.equal(String(versionAfter), String(versionBefore), "touch does not invalidate the table snapshot cache");

  await store.touch("missing-id", 5);
  assert.equal((await raw("SELECT count(*) c FROM deployment_access WHERE id = 'missing-id'"))[0]!.c, "0");

  await raw("DELETE FROM deployments WHERE id = $1", [d.id]);
  assert.equal(
    (await raw("SELECT count(*) c FROM deployment_access WHERE id = $1", [d.id]))[0]!.c,
    "0",
    "access rows cascade with their deployment",
  );
});

test("touch keeps the max across instances (GREATEST) and debounces per instance", { skip }, async () => {
  const a = makeStore({ touchDebounceMs: 0 }).store;
  const b = makeStore({ touchDebounceMs: 0 }).store;
  const d = await a.create(createInput());

  await a.touch(d.id, 2_000);
  await b.touch(d.id, 500);
  assert.equal((await b.get(d.id))!.lastAccessAt, 2_000, "a late lower write never regresses last-access");
  await b.touch(d.id, 3_000);
  assert.equal((await a.get(d.id))!.lastAccessAt, 3_000);

  const debounced = makeStore().store;
  await debounced.touch(d.id, 10_000);
  await debounced.touch(d.id, 50_000);
  assert.equal(
    Number((await raw("SELECT last_access_at FROM deployment_access WHERE id = $1", [d.id]))[0]!.last_access_at),
    10_000,
    "a touch inside the 60s window is skipped",
  );
  await debounced.touch(d.id, 70_001);
  assert.equal((await debounced.get(d.id))!.lastAccessAt, 70_001);
});

test("getByName resolves by indexed SQL lookup and hydrates last-access", { skip }, async () => {
  const { store } = makeStore({ touchDebounceMs: 0 });
  const d = await store.create(createInput("slug-app"));
  assert.equal((await store.getByName("slug-app"))!.id, d.id);
  assert.equal(await store.getByName("no-such-app"), null);
  await store.touch(d.id, 4_242);
  assert.equal((await store.getByName("slug-app"))!.lastAccessAt, 4_242);
});

test("a racing create with a taken name fails on the unique index, not just the pre-check", { skip }, async () => {
  const a = makeStore().store;
  const b = makeStore().store;
  await a.create(createInput("contested"));
  await assert.rejects(b.create(createInput("contested")), /deployment name taken: contested/);
});

test("renaming onto a taken name is rejected by the unique index", { skip }, async () => {
  const { store } = makeStore();
  await store.create(createInput("held"));
  const other = await store.create(createInput("free"));
  await assert.rejects(store.setName(other.id, "held"), /deployment name taken: held/);
  assert.equal((await store.get(other.id))!.name, "free");
});

test("rows never touched since the split fall back to the blob's legacy lastAccessAt", { skip }, async () => {
  const { store, factory } = makeStore({ touchDebounceMs: 0 });
  const d = await store.create(createInput());
  await factory.map<Deployment>("deployments").merge(d.id, { lastAccessAt: 777 } as Partial<Deployment>);
  assert.equal((await store.get(d.id))!.lastAccessAt, 777);
  await store.touch(d.id, 9_999);
  assert.equal((await store.get(d.id))!.lastAccessAt, 9_999, "the access table wins once a touch lands");
});

test("pre-existing duplicate names degrade gracefully: no index, deterministic getByName", { skip }, async () => {
  await raw("DROP INDEX IF EXISTS deployments_name_unique");
  const seed = makeFactory().map<Deployment>("deployments");
  const dup = (id: string): Deployment => ({
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    name: "doubled",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [],
  });
  await seed.put("dup-a", dup("dup-a"));
  await seed.put("dup-b", dup("dup-b"));

  const { store } = makeStore();
  assert.equal((await store.getByName("doubled"))!.id, "dup-a", "lowest id wins, matching the old all().find order");
  const created = await store.create(createInput("fresh-name"));
  assert.equal((await store.getByName("fresh-name"))!.id, created.id);
});

test(
  "credential bindings persist across store instances and revocation survives unrelated writes",
  { skip },
  async () => {
    const first = makeStore().store;
    const d = await first.create(createInput());
    const binding = {
      credentialId: "fixture-credential",
      ownerId: "U1",
      host: "api.example.com",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/v1/usage"],
      headers: [{ name: "Authorization", field: "API_TOKEN", scheme: "Bearer" }],
    };
    await first.setCredentialBindings(d.id, [binding], (await first.get(d.id))!);
    const second = makeStore().store;
    assert.deepEqual((await second.get(d.id))?.credentialBindings, [binding]);
    await Promise.all([
      first.setCredentialBindings(d.id, [], (await first.get(d.id))!),
      second.setDisplayName(d.id, "Renamed fixture"),
      second.setStatus(d.id, "running"),
      second.setAlwaysOn(d.id, true),
    ]);
    assert.deepEqual((await first.get(d.id))?.credentialBindings, []);
    assert.equal((await first.get(d.id))?.displayName, "Renamed fixture");
    await first.setCredentialBindings(d.id, [binding], (await first.get(d.id))!);
    await second.setOwnerScope(d.id, scopeId("personal", "U2"));
    await second.setOwnerScope(d.id, scopeId("personal", "U1"));
    assert.deepEqual((await first.get(d.id))?.credentialBindings, []);
  },
);

test(
  "credential bindings survive store recreation and atomic lifecycle updates fence stale approvals",
  { skip },
  async () => {
    const { store } = makeStore();
    const d = await store.create(createInput());
    const binding = {
      credentialId: "fake-id",
      ownerId: "U1",
      host: "api.example.com",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/data"],
      headers: [{ name: "Authorization", field: "TOKEN" }],
    };
    assert.equal(await store.setCredentialBindings(d.id, [binding], d), true);
    const { store: other } = makeStore();
    const approved = (await other.get(d.id))!;
    assert.deepEqual(approved.credentialBindings, [binding]);
    assert.equal(await other.setCredentialBindings(d.id, [], approved), true);
    assert.equal(await store.setCredentialBindings(d.id, [binding], approved), false);
    await store.addVersion(d.id, { entrypoint: "v2", snapshotDir: "/v2" });
    await store.setCurrentVersion(d.id, 1);
    await store.setVersionImage(d.id, 1, "fake-image");
    await store.setName(d.id, `binding-${d.id}`);
    await store.setDisplayName(d.id, "Bound app");
    await store.setAppliedVersion(d.id, 1);
    await store.setEndpoint(d.id, { host: "127.0.0.1", port: 1234 });
    await store.setStatus(d.id, "running");
    assert.deepEqual((await other.get(d.id))!.credentialBindings, []);
    const beforeArchive = (await other.get(d.id))!;
    await store.setStatus(d.id, "archived");
    await store.setStatus(d.id, "running");
    assert.equal(await other.setCredentialBindings(d.id, [binding], beforeArchive), false);
    const beforeTransfer = (await other.get(d.id))!;
    await store.setOwnerScope(d.id, scopeId("personal", "U2"));
    await store.setOwnerScope(d.id, d.ownerScopeId);
    assert.equal(await other.setCredentialBindings(d.id, [binding], beforeTransfer), false);
    assert.deepEqual((await makeStore().store.get(d.id))!.credentialBindings, []);
  },
);
