import assert from "node:assert/strict";
import test from "node:test";
import { claudeHarnessConfigOptions } from "../src/harness/claude-harness.ts";
import { codexHarnessConfigOptions } from "../src/harness/codex-harness.ts";
import { openCodeHarnessConfigOptions } from "../src/harness/opencode-harness.ts";
import { testConfig } from "./support/test-config.ts";

for (const options of [claudeHarnessConfigOptions, codexHarnessConfigOptions, openCodeHarnessConfigOptions]) {
  test(`${options.name} routes delegation through QM when coordination is enabled`, () => {
    assert.equal(options(testConfig({ coordinationEnabled: true })).nativeSubagents, false);
    assert.equal(options(testConfig({ coordinationEnabled: false })).nativeSubagents, true);
  });
}
