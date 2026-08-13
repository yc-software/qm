import test from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createOpenCodeHarness } from "../src/harness/opencode-harness.ts";
import { createCodexHarness } from "../src/harness/codex-harness.ts";
import { createClaudeHarness } from "../src/harness/claude-harness.ts";
import { createCmaHarness } from "../src/harness/cma-harness.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";

test("harness adapters declare their native control and tool transports", async (t) => {
  const mock = createMockHarness();
  const pi = createPiHarness();
  const opencode = createOpenCodeHarness();
  const codex = createCodexHarness();
  const claude = createClaudeHarness();
  const cma = createCmaHarness();
  t.after(async () => {
    await pi.turns.close?.();
    await opencode.turns.close?.();
  });

  assert.deepEqual(
    [
      mock.profile.controlTransport,
      pi.profile.controlTransport,
      opencode.profile.controlTransport,
      codex.profile.controlTransport,
      claude.profile.controlTransport,
      cma.profile.controlTransport,
    ],
    ["mock", "in-process", "http", "json-rpc", "sdk", "api"],
  );
  assert.deepEqual(
    [
      mock.profile.toolTransport,
      pi.profile.toolTransport,
      opencode.profile.toolTransport,
      codex.profile.toolTransport,
      claude.profile.toolTransport,
      cma.profile.toolTransport,
    ],
    ["mock", "in-process", "plugin", "dynamic", "in-process-mcp", "dynamic"],
  );
  assert.equal(pi.profile.capabilities.has("fast-mode"), true);
  assert.equal(opencode.profile.capabilities.has("fast-mode"), false);
  assert.equal(opencode.profile.capabilities.has("thinking-level"), false);
  assert.equal(cma.profile.capabilities.has("provider-sessions"), true);
  assert.equal(cma.profile.capabilities.has("fast-mode"), false);
  assert.equal(cma.profile.capabilities.has("thinking-level"), true);
});

test("tool presentation belongs to the adapter", () => {
  const pi = createPiHarness();
  const opencode = createOpenCodeHarness();

  assert.equal(pi.tools.name("read"), "read");
  assert.equal(opencode.tools.name("read"), "workspace_read");
  assert.equal(opencode.tools.name("execute"), "workspace_execute");
  assert.equal(opencode.tools.name("write"), "workspace_write");
});

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});
