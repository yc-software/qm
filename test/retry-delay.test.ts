import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../src/runs/retry-delay.ts";

test("retry delays grow with bounded jitter and stay capped at 60s", (t) => {
  for (const [random, expected] of [
    [0, [15000, 30000, 60000, 60000]],
    [0.5, [16500, 33000, 60000, 60000]],
    [0.999999, [18000, 36000, 60000, 60000]],
  ] as const) {
    t.mock.method(Math, "random", () => random);
    assert.deepEqual(
      [0, 1, 2, 100].map((attempt) => retryDelay(attempt)),
      expected,
    );
    t.mock.restoreAll();
  }
});
