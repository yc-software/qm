import test from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "./support/mock-harness.ts";
import { createClaudeHarness } from "../src/harness/claude-harness.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";

test("harness adapters declare their native control and tool transports", async (t) => {
  const pi = createPiHarness();
  const claude = createClaudeHarness();
  t.after(async () => {
    await pi.turns.close?.();
  });

  assert.deepEqual([pi.profile.controlTransport, claude.profile.controlTransport], ["in-process", "sdk"]);
  assert.deepEqual([pi.profile.toolTransport, claude.profile.toolTransport], ["in-process", "in-process-mcp"]);
  assert.equal(pi.profile.capabilities.has("fast-mode"), true);
});

test("tool presentation belongs to the adapter", () => {
  const pi = createPiHarness();

  assert.equal(pi.tools.name("read"), "read");
});

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});
