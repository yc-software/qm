import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { countTokens } from "../src/util/tokens.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

function countTempDirs(prefix: string): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

function recordingTurn(
  systemPrompt: string,
  recorded: Array<{ model: string; inputTokens: number; entryCount: number }>,
  sessionId: string,
): HarnessTurnInput {
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "hi",
    systemPrompt,
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "scope" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => ({ ...entry, seq: 1 }) as Awaited<ReturnType<HarnessTurnInput["emit"]>>,
    recordModelCall: (rec) => recorded.push(rec),
  };
}

async function runIgnoringPromptError(
  harness: ReturnType<typeof createPiHarness>,
  turn: HarnessTurnInput,
): Promise<void> {
  try {
    await harness.turns.runTurn(turn);
  } catch {
    return;
  }
}

test("every turn composes the freshly resolved system prompt", async () => {
  const harness = createPiHarness();
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];
  const first = "BASE\n\n## What you remember\nA";
  const second = "BASE\n\n## What you remember\nBBBBBBBBBBBBBBBBBBBB";

  await runIgnoringPromptError(harness, recordingTurn(first, recorded, "fresh-prompt"));
  await runIgnoringPromptError(harness, recordingTurn(second, recorded, "fresh-prompt"));

  assert.equal(recorded[0]!.inputTokens, countTokens(first) + countTokens("hi"));
  assert.equal(recorded[1]!.inputTokens, countTokens(second) + countTokens("hi"));
});

test("each turn removes its isolated resource directories", async () => {
  const prefix = `pi-turn-${process.pid}`;
  const harness = createPiHarness({ tempDirPrefix: prefix });
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];

  await runIgnoringPromptError(harness, recordingTurn("BASE", recorded, "cleanup"));

  assert.equal(countTempDirs(`${prefix}-cwd-`), 0);
  assert.equal(countTempDirs(`${prefix}-agent-`), 0);
});

test("the Pi harness exposes no session-reset hook after removing session state", () => {
  assert.equal(createPiHarness().turns.resetSession, undefined);
});

test("ack emoji keeps working on a non-Anthropic base model when an Anthropic key is present", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-test" }),
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; model: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), model: JSON.parse(String(init?.body ?? "{}")).model });
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"emoji":"eyes"}' }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const picked = await harness.models.pickAckEmoji?.("ship it", ["eyes", "rocket"]);
    assert.equal(picked, "eyes", "the pick still lands even though the base model is OpenAI");
    assert.equal(calls.length, 1, "the Anthropic ack call was actually attempted");
    assert.match(calls[0]!.url, /anthropic/, "it went to the Anthropic API");
    assert.equal(calls[0]!.model, "claude-haiku-4-5", "it used the Anthropic auxiliary, not the OpenAI judge model");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ack emoji stays home when the deployment has no Anthropic key at all", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ openai: "sk-openai-test" }),
  });
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await harness.models.pickAckEmoji?.("ship it", ["eyes"]), undefined);
    assert.equal(called, 0, "no Anthropic call without an Anthropic key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("model utilities resolve provider credentials for every call", async () => {
  let resolutions = 0;
  const harness = createPiHarness({
    resolveProviderKeys: async () => {
      resolutions += 1;
      return {};
    },
  });

  assert.equal(await harness.models.oneShot?.("system", "first"), undefined);
  assert.equal(await harness.models.oneShot?.("system", "second"), undefined);
  assert.equal(resolutions, 2);
});

test("prior-turn bootstrap is taped as a retry-idempotent import before the first prompt", async () => {
  const harness = createPiHarness();
  const records: Array<{ kind: string; payload: unknown }> = [];
  const turn = recordingTurn("BASE", [], "prior-bootstrap");
  turn.priorTurns = [
    { role: "assistant", text: "I opened this thread with the release result" },
    { role: "user", name: "Jordan", text: "tell me more" },
  ];
  turn.tape = async (record) => {
    records.push({ kind: record.kind, payload: record.payload });
  };
  await runIgnoringPromptError(harness, turn);
  const bootstrap = records.filter((record) => record.kind === "context_event");
  assert.equal(bootstrap.length, 1);
  assert.equal((bootstrap[0]!.payload as { event?: string }).event, "legacy_import");
  assert.match(JSON.stringify(bootstrap[0]), /release result/);
  assert.match(JSON.stringify(bootstrap[0]), /tell me more/);
});
