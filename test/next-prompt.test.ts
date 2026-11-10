import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { scopeId } from "../src/types.ts";

test("next-prompt suggestions run only for people with the flag, on the session's latest reply", async () => {
  const transcripts: string[] = [];
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-next-prompt-")) }), {
    agent: {
      ...createMockAgent(),
      suggestNextPrompt: async (transcript: string) => {
        transcripts.push(transcript);
        return "merge it";
      },
    },
  });
  const turn = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:next-prompt" },
    text: "Open the PR for the sidebar fix",
  });
  assert.equal(turn.status, "ok");
  const sessionId = turn.sessionId!;

  assert.deepEqual(await built.app.suggestNextPrompt(sessionId, "U1"), { enabled: false, suggestion: null });
  assert.equal(transcripts.length, 0, "no model call while the flag is off");

  await built.featureFlags.setEnabled("next_prompt_suggestions", scopeId("personal", "U1"), true, "test");
  assert.deepEqual(await built.app.suggestNextPrompt(sessionId, "U1"), { enabled: true, suggestion: "merge it" });
  assert.equal(transcripts.length, 1);
  assert.match(
    transcripts[0]!,
    /^<conversation>\nUser:\nOpen the PR for the sidebar fix\n\nAssistant:\n[\s\S]+\n<\/conversation>$/,
  );

  assert.equal(
    await built.app.suggestNextPrompt(sessionId, "stranger"),
    null,
    "no suggestions on a session they cannot read",
  );
});
