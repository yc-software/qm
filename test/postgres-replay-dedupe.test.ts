import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the replay-dedupe tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS source_auth_replay CASCADE");
  await p.end();
});

test("pg replay dedupe: first claim wins; replays lose across sibling/restarted instances", { skip }, async () => {
  const a = createPostgresReplayDedupe(URL!);
  const b = createPostgresReplayDedupe(URL!);
  const exp = Date.now() + 60_000;

  assert.equal(await a.claim("evt-1", exp), true);
  assert.equal(await a.claim("evt-1", exp), false, "same instance sees the duplicate");
  assert.equal(await b.claim("evt-1", exp), false, "a sibling or freshly-restarted instance sees it too");
  assert.equal(await b.claim("evt-2", exp), true, "unrelated events still pass");
});

test("pg replay dedupe: expired entries are pruned and don't block claims forever", { skip }, async () => {
  const a = createPostgresReplayDedupe(URL!);
  assert.equal(await a.claim("evt-expired", Date.now() - 1_000), true);
  const later = createPostgresReplayDedupe(URL!);
  assert.equal(await later.claim("evt-expired", Date.now() + 60_000), true);
});
