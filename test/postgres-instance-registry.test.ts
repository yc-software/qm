import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresInstanceRegistry } from "../src/runs/instance-registry.ts";
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
      deploymentKey: "sha-a",
      startedAt: 1000,
      livenessMs: 1_000,
    });
    assert.equal((await old.beat(true)).superseded, false, "alone: not superseded");

    const peer = createPostgresInstanceRegistry(pool, {
      instanceId: "i-peer",
      deploymentKey: "sha-a",
      startedAt: 2000,
      livenessMs: 1_000,
    });
    await peer.beat(true);
    assert.equal((await old.beat(true)).superseded, false, "same-sha peer (scale-out) never drains");

    const next = createPostgresInstanceRegistry(pool, {
      instanceId: "i-new",
      deploymentKey: "sha-b",
      startedAt: 3000,
      livenessMs: 1_000,
    });
    await next.beat(true);
    assert.equal((await old.beat(true)).superseded, true, "newer build live: superseded");
    assert.equal((await next.beat(true)).superseded, false, "the newest build itself is not superseded");

    await old.retire();
    await peer.retire();
    const replaced = createPostgresInstanceRegistry(pool, {
      instanceId: "i-old-replacement",
      deploymentKey: "sha-a",
      startedAt: 4000,
      livenessMs: 1_000,
    });
    await next.beat(true);
    assert.equal(
      (await replaced.beat(true)).superseded,
      true,
      "a task replacing every stopped task of the older deployment stays behind the newer one",
    );
    assert.equal(
      (await next.beat(true)).superseded,
      false,
      "the replacement does not take over from the newer deployment",
    );

    await pool.query(
      "UPDATE instance_heartbeats SET beat_at = now() - interval '2 hours' WHERE instance_id IN ('i-old', 'i-peer')",
    );
    await next.beat(true);
    assert.equal(
      (await replaced.beat(true)).superseded,
      true,
      "the older deployment keeps its first start while any of its processes is alive, however long ago that start was",
    );
    await next.retire();
    assert.equal((await old.beat(true)).superseded, false, "a newer build that stops cleanly hands back at once");

    const crashed = createPostgresInstanceRegistry(pool, {
      instanceId: "i-crashed",
      deploymentKey: "sha-c",
      startedAt: 5000,
      livenessMs: 1_000,
    });
    await crashed.beat(true);
    assert.equal((await old.beat(true)).superseded, true, "a newer build drains the old one again");
    await new Promise((r) => setTimeout(r, 1_100));
    assert.equal(
      (await old.beat(true)).superseded,
      false,
      "the newer build's beats went stale (failed deploy): claiming resumes",
    );
  },
);

test("a newer deployment sees an older one running until it stands down, retires or goes stale", { skip }, async () => {
  const pool = createPostgresMapFactory(URL!).pool;
  await pool.query("DELETE FROM instance_heartbeats");
  const registry = (instanceId: string, deploymentKey: string, startedAt: number) =>
    createPostgresInstanceRegistry(pool, { instanceId, deploymentKey, startedAt, livenessMs: 1_000 });
  const older = registry("i-older", "dep-older", 1000);
  const newer = registry("i-newer", "dep-newer", 2000);
  await older.beat(true);
  assert.deepEqual(await newer.beat(false), { superseded: false, olderRunning: true }, "older build still runs");
  assert.deepEqual(await older.beat(false), { superseded: true, olderRunning: false }, "older build stood down");
  assert.deepEqual(await newer.beat(false), { superseded: false, olderRunning: false }, "newer build may resume");
  assert.deepEqual(
    await newer.beat(true),
    { superseded: false, olderRunning: false },
    "a newer build never waits on itself",
  );

  const rollback = registry("i-older-2", "dep-older", 3000);
  await rollback.beat(true);
  assert.equal((await newer.beat(true)).olderRunning, true, "a resumed older build is visible to the newer one");
  await rollback.retire();
  assert.equal((await newer.beat(true)).olderRunning, false, "a retired process no longer counts as running");
  await older.beat(true);
  await new Promise((r) => setTimeout(r, 1_100));
  assert.equal((await newer.beat(true)).olderRunning, false, "a stale heartbeat no longer counts as running");
});

test(
  "a core with background work disabled never heartbeats, so it cannot drain a peer that does",
  { skip },
  async () => {
    await import("./support/auto-fake-sprites.ts");
    const [{ buildApp }, { testConfig }] = await Promise.all([
      import("./support/build-app.ts"),
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

test(
  "a configured deployment id keys the heartbeat, so a config-only redeploy of one build still supersedes",
  { skip },
  async () => {
    await import("./support/auto-fake-sprites.ts");
    const [{ buildApp }, { testConfig }] = await Promise.all([
      import("./support/build-app.ts"),
      import("./support/test-config.ts"),
    ]);
    const pool = createPostgresMapFactory(URL!).pool;
    const built = buildApp(
      testConfig({
        databaseUrl: URL,
        buildSha: "sha-shared",
        backgroundDeploymentId: "deployment-green",
        workers: 1,
        reaperIntervalMs: 60_000,
      }),
    );
    built.runtime.start();
    const keys = async (): Promise<string[]> =>
      (
        await pool.query("SELECT DISTINCT build_sha FROM instance_heartbeats WHERE build_sha IN ($1, $2)", [
          "sha-shared",
          "deployment-green",
        ])
      ).rows.map((row) => (row as { build_sha: string }).build_sha);
    await settle(async () => (await keys()).length > 0);
    const seen = await keys();
    await built.runtime.stop();
    assert.deepEqual(seen, ["deployment-green"]);
  },
);
