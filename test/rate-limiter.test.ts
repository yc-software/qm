import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";

test("rate limits are principal-scoped and reset after the window", async () => {
  let now = 1_000;
  const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 60_000, now: () => now });
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, false);
  assert.equal((await limiter.check("bob")).allowed, true);
  now += 60_000;
  assert.equal((await limiter.check("alice")).allowed, true);
});
