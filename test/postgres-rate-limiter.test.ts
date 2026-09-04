import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRateLimiter } from "../src/ratelimit/postgres-rate-limiter.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL to run the Postgres rate-limiter test";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query("DROP TABLE IF EXISTS rate_limit_windows CASCADE");
  await pool.end();
});

test("Postgres rate limits are shared across instances", { skip }, async () => {
  const a = createPostgresRateLimiter(URL!, { maxPerWindow: 2, windowMs: 60_000 });
  const b = createPostgresRateLimiter(URL!, { maxPerWindow: 2, windowMs: 60_000 });
  assert.equal((await a.check("alice")).allowed, true);
  assert.equal((await b.check("alice")).allowed, true);
  assert.equal((await a.check("alice")).allowed, false);
  assert.equal((await b.check("bob")).allowed, true);
});
