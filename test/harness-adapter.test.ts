import test from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createOpenCodeHarness, openCodeHarnessConfigOptions } from "../src/harness/opencode-harness.ts";
import { createCodexHarness, codexHarnessConfigOptions } from "../src/harness/codex-harness.ts";
import { createClaudeHarness, claudeHarnessConfigOptions } from "../src/harness/claude-harness.ts";
import { createPiHarness, piHarnessConfigOptions } from "../src/harness/pi-harness.ts";
import {
  createPiTools,
  harnessToolOptions,
  type CoreToolOptions,
  type ToolContextRef,
} from "../src/harness/pi-tools.ts";
import type { Config } from "../src/config.ts";
import { testConfig } from "./support/test-config.ts";

test("harness adapters declare their native control and tool transports", async (t) => {
  const mock = createMockHarness();
  const pi = createPiHarness();
  const opencode = createOpenCodeHarness();
  const codex = createCodexHarness();
  const claude = createClaudeHarness();
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
    ],
    ["mock", "in-process", "http", "json-rpc", "sdk"],
  );
  assert.deepEqual(
    [
      mock.profile.toolTransport,
      pi.profile.toolTransport,
      opencode.profile.toolTransport,
      codex.profile.toolTransport,
      claude.profile.toolTransport,
    ],
    ["mock", "in-process", "plugin", "dynamic", "in-process-mcp"],
  );
  assert.equal(pi.profile.capabilities.has("fast-mode"), true);
  assert.equal(opencode.profile.capabilities.has("fast-mode"), false);
  assert.equal(opencode.profile.capabilities.has("thinking-level"), false);
});

test("tool presentation belongs to the adapter", () => {
  const pi = createPiHarness();
  const opencode = createOpenCodeHarness();

  assert.equal(pi.tools.name("read"), "read");
  assert.equal(opencode.tools.name("read"), "workspace_read");
  assert.equal(opencode.tools.name("execute"), "workspace_execute");
  assert.equal(opencode.tools.name("write"), "workspace_write");
});

test("every harness forwards configured tool flags into the tools it hands the model", () => {
  const ref: ToolContextRef = { current: null };
  const builders = [
    ["pi", piHarnessConfigOptions],
    ["claude", claudeHarnessConfigOptions],
    ["codex", codexHarnessConfigOptions],
    ["opencode", openCodeHarnessConfigOptions],
  ] as const;
  const toolNames = (build: (config: Config) => CoreToolOptions, config: Config): string[] =>
    createPiTools(ref, harnessToolOptions(build(config), {})).map((tool) => tool.name);

  for (const [harness, build] of builders) {
    assert.ok(toolNames(build, testConfig()).includes("web"), `${harness} offers web with no key configured`);
    assert.ok(
      toolNames(build, testConfig({ signingSecret: "sek", apiBaseUrl: "https://core.test" })).includes("cron"),
      `${harness} forwards control tools the same way`,
    );
    assert.ok(!toolNames(build, testConfig()).includes("cron"), `${harness} withholds control tools by default`);
  }
});

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});
