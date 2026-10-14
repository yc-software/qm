import { test } from "node:test";
import assert from "node:assert/strict";
import { needsHistoryImport } from "../src/harness/opencode-plugin.ts";

test("OpenCode plugin imports empty history only on the first model step", () => {
  const user = { info: { id: "user", role: "user", sessionID: "session" }, parts: [] };
  const assistant = { info: { id: "assistant", role: "assistant", sessionID: "session" }, parts: [] };
  assert.equal(needsHistoryImport([user], []), true);
  assert.equal(needsHistoryImport([user, assistant], []), false);
});

test("OpenCode plugin recognizes imported non-empty history", () => {
  const user = { info: { id: "user", role: "user", sessionID: "session" }, parts: [] };
  const prior = { info: { id: "prior", role: "assistant", sessionID: "session" }, parts: [] };
  const toolStep = { info: { id: "tool-step", role: "assistant", sessionID: "session" }, parts: [] };
  assert.equal(needsHistoryImport([user], [prior]), true);
  assert.equal(needsHistoryImport([prior, user], [prior]), false);
  assert.equal(needsHistoryImport([user, toolStep], [prior]), false);
});
