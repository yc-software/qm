import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { SessionEntry, Session, ScopeId } from "../src/types.ts";

let options: Record<string, unknown> = {};
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
    query: (input: { options: Record<string, unknown> }) => {
      options = input.options;
      return {
        initializationResult: async () => ({}),
        interrupt: async () => {},
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            num_turns: 1,
            usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      };
    },
  },
});
const { createClaudeHarness, claudeHarnessConfigOptions } = await import("../src/harness/claude-harness.ts");
const { codexHarnessConfigOptions } = await import("../src/harness/codex-harness.ts");
const { openCodeHarnessConfigOptions } = await import("../src/harness/opencode-harness.ts");
const { testConfig } = await import("./support/test-config.ts");

for (const sandboxResources of [false, true])
  for (const readOnly of [false, true]) {
    test(`Claude native delegation obeys existing sandbox policy resources=${sandboxResources} readOnly=${readOnly}`, async () => {
      const harness = createClaudeHarness({ sandboxResources });
      const input = {
        session: { id: "policy" } as Session,
        input: "hi",
        systemPrompt: "policy",
        history: [],
        readOnly,
        tools: {} as HarnessTurnInput["tools"],
        scopeLabel: "personal:policy" as ScopeId,
        orgScopeId: "org:policy" as ScopeId,
        emit: async (entry: unknown) =>
          ({ ...(entry as object), sessionId: "policy", seq: 1, createdAt: Date.now() }) as SessionEntry,
        recordModelCall: () => {},
      } as HarnessTurnInput;
      try {
        assert.equal((await harness.turns.runTurn(input)).reply, "done");
        const allowed = !sandboxResources && !readOnly;
        assert.deepEqual(options.tools, allowed ? ["Agent"] : []);
        assert.equal(Boolean(options.agents), allowed);
        assert.equal((options.allowedTools as string[]).includes("Agent"), allowed);
      } finally {
        await harness.turns.close?.();
      }
    });
  }

test("all native harnesses receive the same existing sandbox capability, without a coordination toggle", () => {
  for (const sandboxResourcesEnabled of [false, true]) {
    const config = testConfig({ sandboxResourcesEnabled });
    for (const resolve of [claudeHarnessConfigOptions, codexHarnessConfigOptions, openCodeHarnessConfigOptions])
      assert.equal(resolve(config).sandboxResources, sandboxResourcesEnabled);
  }
});
