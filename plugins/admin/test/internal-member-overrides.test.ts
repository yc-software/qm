import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the org page does not expose internal member overrides", () => {
  const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /internal-member-overrides/);
});
