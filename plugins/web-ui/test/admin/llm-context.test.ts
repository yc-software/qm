import assert from "node:assert/strict";
import test from "node:test";
import { sumCacheUsage, isStablePrefixMiss } from "../../src/admin/llm-context.ts";

test("model context flags cache misses from per-call usage", () => {
  const usage = sumCacheUsage([{ usage: { cacheRead: 0, cacheWrite: 4000, input: 10 } }]);
  assert.equal(isStablePrefixMiss(usage), true);
});
