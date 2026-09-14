import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { testConfig } from "./support/test-config.ts";

const codex = await import("../src/harness/codex-harness.ts");
const seen: HarnessTurnInput[] = [];
mock.module("../src/harness/codex-harness.ts", {
  namedExports: {
    ...codex,
    createCodexHarness: () => {
      const harness = createMockHarness();
      return {
        ...harness,
        id: "codex",
        turns: {
          ...harness.turns,
          runTurn: async (turn: HarnessTurnInput) => {
            seen.push(turn);
            return { reply: "subscription model selected", modelCalls: 1 };
          },
        },
      };
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

test("web Astra selection reaches Codex with personal OAuth through app and orchestrator", async () => {
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false }));
  try {
    built.config.setIndividualModelAuth(true);
    built.config.setApprovedHarnesses(["mock", "codex", "claude"]);
    await built.config.flushScope("org:default-org");
    await built.config.setRuntimeSelectionLatest("org:default-org", {
      harnessId: "claude",
      modelId: "claude-sonnet-5",
    });
    await built.userModelCredentials.setOAuth("internal:alice", "openai", {
      accessToken: "test-access",
      idToken: "test-id",
      accountId: "test-account",
      expiresAt: Date.now() + 3600000,
    });
    const request = {
      surface: "web",
      liveActor: true,
      actor: { externalId: "internal:alice" },
      conversation: { kind: "dm" as const, threadRef: "subscription-astra-test" },
      text: "Test the selected model",
      harness: "codex",
      model: "gpt-6-astra",
      skipMemory: true,
    };
    const result = await built.app.turn(request);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.runtime?.modelId, "gpt-6-astra");
    assert.equal(seen[0]?.codexAuth?.accountId, "test-account");
    await built.userModelCredentials.delete("internal:alice", "openai");
    assert.equal(
      (await built.app.turn({ ...request, conversation: { ...request.conversation, threadRef: "disconnected-test" } }))
        .status,
      "refused",
    );
    assert.equal(seen.length, 1);
  } finally {
    await built.runtime.stop();
  }
});
