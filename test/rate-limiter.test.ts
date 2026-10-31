import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createPostgresRateLimiter } from "../src/ratelimit/postgres-rate-limiter.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("rate limits are principal-scoped and reset after the window", async () => {
  const windowMs = 1_000;
  const limiter = createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 2, windowMs });
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, false);
  assert.equal((await limiter.check("bob")).allowed, true);
  await sleep(windowMs + 50);
  assert.equal((await limiter.check("alice")).allowed, true);
});
