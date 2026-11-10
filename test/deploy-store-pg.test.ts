import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresMapFactory, type PostgresArtifactMaps } from "../src/persistence/durable-map.ts";
import { createDeployStore, type Deployment, type DeployStore } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";
import { testBareDatabaseUrl, testDeployBackings } from "./support/test-database.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { DEPLOYMENT_TABLES } from "../src/deploy/page-views.ts";

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
  const store = createDeployStore(
    testDeployBackings({
      deployments: factory.map<Deployment>("deployments", undefined, DEPLOYMENT_TABLES),
      pg: factory.pool,
      git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-pg-")) },
      ...opts,
    }),
  );
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
  await factory
    .map<Deployment>("deployments", undefined, DEPLOYMENT_TABLES)
    .merge(d.id, { lastAccessAt: 777 } as Partial<Deployment>);
  assert.equal((await store.get(d.id))!.lastAccessAt, 777);
  await store.touch(d.id, 9_999);
  assert.equal((await store.get(d.id))!.lastAccessAt, 9_999, "the access table wins once a touch lands");
});

test("pre-existing duplicate names degrade gracefully: no index, deterministic getByName", { skip }, async () => {
  await raw("DROP INDEX IF EXISTS deployments_name_unique");
  const seed = makeFactory().map<Deployment>("deployments", undefined, DEPLOYMENT_TABLES);
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

test("the name index migration skips a tenant's duplicate names instead of failing", { skip }, async () => {
  const pg = (await import("pg")).default;
  for (const duplicated of [true, false]) {
    const owner = new pg.Pool({ connectionString: testBareDatabaseUrl(), max: 1 });
    try {
      const nameIndex = DEPLOYMENT_TABLES.filter((m) => m.id.endsWith("-name-index")).map(definePgMigration);
      const tables = DEPLOYMENT_TABLES.filter((m) => !m.id.endsWith("-name-index")).map(definePgMigration);
      await applyPgMigrations(owner, tables);
      await owner.query("INSERT INTO tenants DEFAULT VALUES");
      const tenant = (await owner.query("SELECT id FROM tenants LIMIT 1")).rows[0].id;
      for (const id of duplicated ? ["a", "b"] : ["a"])
        await owner.query("INSERT INTO deployments (tenant_id, id, json) VALUES ($1, $2, $3)", [
          tenant,
          id,
          { name: "same" },
        ]);
      await applyPgMigrations(owner, nameIndex);
      const index = await owner.query("SELECT to_regclass('deployments_name_unique') AS i");
      assert.equal(index.rows[0].i === null, duplicated);
    } finally {
      await owner.end();
    }
  }
});

test("concurrent field writes and new versions from two instances all land", { skip }, async () => {
  const a = makeStore().store;
  const b = makeStore().store;
  const d = await a.create(createInput());
  for (let i = 0; i < 25; i++) {
    const status = i % 2 ? "running" : "stopped";
    const host = `h${i}.example.test`;
    await Promise.all([a.setStatus(d.id, status), b.setEndpoint(d.id, { host, port: 443 })]);
    const blob = (await raw("SELECT json FROM deployments WHERE id = $1", [d.id]))[0]!.json as Deployment;
    assert.equal(blob.status, status, `status survives a concurrent endpoint write (round ${i})`);
    assert.equal(blob.endpoint?.host, host, `endpoint survives a concurrent status write (round ${i})`);
  }
  for (let i = 0; i < 10; i++) {
    const status = i % 2 ? "running" : "stopped";
    await Promise.all([
      a.addVersion(d.id, { entrypoint: "node s.js", snapshotDir: "/snap" }),
      b.setStatus(d.id, status),
    ]);
    const blob = (await raw("SELECT json FROM deployments WHERE id = $1", [d.id]))[0]!.json as Deployment;
    assert.equal(blob.status, status, `status survives a concurrent new version (round ${i})`);
    assert.equal(blob.versions.length, i + 2, `new version survives a concurrent status write (round ${i})`);
  }
  await a.setStatus("missing-id", "stopped");
  assert.equal((await raw("SELECT count(*) c FROM deployments WHERE id = 'missing-id'"))[0]!.c, "0");
});

test("version setters from two instances keep each other's writes on Postgres", { skip }, async () => {
  const a = makeStore().store;
  const b = makeStore().store;
  const d = await a.create({ ...createInput(), files: [{ path: "s.js", data: "1" }] });
  await a.addVersion(d.id, { entrypoint: "node s.js", snapshotDir: "/snap", files: [{ path: "s.js", data: "2" }] });
  const blob = async () => (await raw("SELECT json FROM deployments WHERE id = $1", [d.id]))[0]!.json as Deployment;

  for (let i = 0; i < 10; i++) {
    const status = i % 2 ? "running" : "stopped";
    await Promise.all([a.setCurrentVersion(d.id, (i % 2) + 1), b.setStatus(d.id, status)]);
    assert.equal((await blob()).status, status, `status survives a concurrent current-version write (round ${i})`);
    assert.equal((await blob()).currentVersion, (i % 2) + 1);
  }

  await Promise.all([a.setAppliedVersion(d.id, 2), b.setEndpoint(d.id, { host: "x.example.test", port: 443 })]);
  assert.equal((await blob()).appliedVersion, 2);
  assert.equal((await blob()).endpoint?.host, "x.example.test");
  await assert.rejects(a.setAppliedVersion(d.id, 99), /no such version 99/);
  assert.equal((await blob()).appliedVersion, 2);

  const results = await Promise.allSettled([
    a.addVersion(d.id, { entrypoint: "node s.js", snapshotDir: "/snap" }),
    b.addVersion(d.id, { entrypoint: "node s.js", snapshotDir: "/snap" }),
  ]);
  const landed = results.filter((r) => r.status === "fulfilled").length;
  assert.ok(landed >= 1);
  for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /gained a version concurrently/);
  assert.equal((await blob()).versions.length, 2 + landed);
});
