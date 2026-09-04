import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
test("a deactivated identity renders an account-deactivated gate, not session expiry", () => {
  assert.match(source, /reason === ["']deactivated["'].*kind: ["']deactivated["']/s);
  const gate = source.slice(source.indexOf("function deactivatedGate"), source.indexOf("function deniedGate"));
  assert.match(gate, /account is deactivated/i);
  assert.doesNotMatch(gate, /session ended/i);
});
