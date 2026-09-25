import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresInstanceRegistry, createLegacyEnrollmentBridge } from "../src/runs/instance-registry.ts";
import { settle } from "./support/settle.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the instance-registry tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS instance_heartbeats CASCADE");
  await p.end();
});

test(
  "supersession: a newer different-sha instance drains the old one; same sha and stale beats don't",
  { skip },
  async () => {
    const pool = createPostgresMapFactory(URL!).pool;
    const old = createPostgresInstanceRegistry(pool, {
      instanceId: "i-old",
      buildSha: "sha-a",
      startedAt: 1000,
      livenessMs: 200,
    });
    assert.equal(await old.beat(), false, "alone: not superseded");

    const peer = createPostgresInstanceRegistry(pool, {
      instanceId: "i-peer",
      buildSha: "sha-a",
      startedAt: 2000,
      livenessMs: 200,
    });
    await peer.beat();
    assert.equal(await old.beat(), false, "same-sha peer (scale-out) never drains");

    const next = createPostgresInstanceRegistry(pool, {
      instanceId: "i-new",
      buildSha: "sha-b",
      startedAt: 3000,
      livenessMs: 200,
    });
    await next.beat();
    assert.equal(await old.beat(), true, "newer build live: superseded");
    assert.equal(await next.beat(), false, "the newest build itself is not superseded");

    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await old.beat(), false, "the newer build's beats went stale (failed deploy): claiming resumes");
  },
);

test("controlled enrollment drains same-image legacy workers without self-supersession", { skip }, async () => {
  const factory = createPostgresMapFactory(URL!);
  const old = createPostgresInstanceRegistry(factory.pool, {
    instanceId: "migration-old",
    buildSha: "same-image",
    startedAt: 10_000,
    livenessMs: 200,
  });
  let eligible = false;
  const bridge = createLegacyEnrollmentBridge(
    createPostgresInstanceRegistry(factory.pool, {
      instanceId: "migration-new",
      buildSha: "enrollment:cohort-a",
      startedAt: 20_000,
      livenessMs: 200,
    }),
    async () => eligible,
  );
  try {
    assert.equal(await bridge.beat(), false);
    assert.equal(await old.beat(), false);
    eligible = true;
    assert.equal(await bridge.beat(), false);
    assert.equal(await old.beat(), true);
    const newer = createPostgresInstanceRegistry(factory.pool, {
      instanceId: "migration-peer",
      buildSha: "another-image",
      startedAt: 30_000,
      livenessMs: 200,
    });
    await newer.beat();
    assert.equal(await bridge.beat(), false);
    eligible = false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await bridge.beat(), false);
    assert.equal(await old.beat(), false);
  } finally {
    await factory.pool.close();
  }
});

test(
  "a core with background work disabled never heartbeats, so it cannot drain a peer that does",
  { skip },
  async () => {
    await import("./support/auto-fake-sprites.ts");
    const [{ buildApp }, { testConfig }] = await Promise.all([
      import("../src/wiring.ts"),
      import("./support/test-config.ts"),
    ]);
    const pool = createPostgresMapFactory(URL!).pool;
    const boot = async (backgroundWorkEnabled: boolean, buildSha: string): Promise<number> => {
      const built = buildApp(
        testConfig({ databaseUrl: URL, buildSha, backgroundWorkEnabled, workers: 1, reaperIntervalMs: 60_000 }),
      );
      built.runtime.start();
      const count = async (): Promise<number> => {
        const { rows } = await pool.query("SELECT count(*)::int AS n FROM instance_heartbeats WHERE build_sha = $1", [
          buildSha,
        ]);
        return (rows[0] as { n: number }).n;
      };
      if (backgroundWorkEnabled) await settle(async () => (await count()) > 0);
      else await new Promise((r) => setTimeout(r, 500));
      const n = await count();
      await built.runtime.stop();
      return n;
    };
    assert.equal(await boot(false, "sha-inactive"), 0, "an inactive stack must leave no heartbeat behind");
    assert.equal(await boot(true, "sha-active"), 1, "a claiming instance still announces itself");
  },
);
