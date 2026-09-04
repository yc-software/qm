import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresInstanceRegistry } from "../src/runs/instance-registry.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the instance-registry tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
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
