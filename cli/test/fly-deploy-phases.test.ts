import { test } from "node:test";
import assert from "node:assert/strict";
import { flyDeployPhases } from "../src/backends/fly.ts";
import type { ServiceName } from "../src/services.ts";

test("fly deploy phases put core first and safe plugins in parallel", () => {
  assert.deepEqual(flyDeployPhases(["core", "admin", "web-ui", "portal"]), [["core"], ["admin", "web-ui", "portal"]]);
});

test("fly deploy phases preserve --only filtering without forcing core", () => {
  assert.deepEqual(flyDeployPhases(["admin", "portal"]), [["admin", "portal"]]);
  assert.deepEqual(flyDeployPhases(["core"] as ServiceName[]), [["core"]]);
});
