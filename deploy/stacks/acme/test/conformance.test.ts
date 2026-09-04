import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { contractVersion, loadConfigAt, validateSandboxLayer } from "@yc-software/qm/contract";

test("acme deployment conforms to contract v1", () => {
  assert.equal(contractVersion, 1);
  loadConfigAt(fileURLToPath(new URL("../qm.config.jsonc", import.meta.url)));
  assert.deepEqual(validateSandboxLayer(fileURLToPath(new URL("../sandbox", import.meta.url))).errors, []);
});
