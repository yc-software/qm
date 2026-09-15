import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stableCwd } from "../src/harness/pi-harness.ts";

test("the cwd pi appends to the system prompt is one constant path per harness", () => {
  assert.equal(stableCwd("pi"), join(tmpdir(), "pi-cwd"));
  assert.equal(stableCwd("pi"), stableCwd("pi"));
});
