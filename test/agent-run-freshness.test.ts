import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTokens } from "../src/util/tokens.ts";
import { createAgent, stableCwd } from "../src/agent/agent-run.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";

function countTempDirs(prefix: string): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

function recordingTurn(
  systemPrompt: string,
  recorded: Array<{ model: string; inputTokens: number; entryCount: number }>,
  sessionId: string,
): AgentTurnInput {
  return {
    session: { id: sessionId } as AgentTurnInput["session"],
    input: "hi",
    systemPrompt,
    history: [],
    tools: {} as AgentTurnInput["tools"],
    scopeLabel: "scope" as AgentTurnInput["scopeLabel"],
    orgScopeId: "org:test" as AgentTurnInput["orgScopeId"],
    emit: async (entry) => ({ ...entry, seq: 1, createdAt: 0 }) as Awaited<ReturnType<AgentTurnInput["emit"]>>,
    recordModelCall: (rec) => recorded.push(rec),
  };
}

async function runIgnoringPromptError(agent: ReturnType<typeof createAgent>, turn: AgentTurnInput): Promise<void> {
  try {
    await agent.runTurn(turn);
  } catch {
    return;
  }
}

test("every turn composes the freshly resolved system prompt", async () => {
  const agent = createAgent();
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];
  const first = "BASE\n\n## What you remember\nA";
  const second = "BASE\n\n## What you remember\nBBBBBBBBBBBBBBBBBBBB";

  await runIgnoringPromptError(agent, recordingTurn(first, recorded, "fresh-prompt"));
  await runIgnoringPromptError(agent, recordingTurn(second, recorded, "fresh-prompt"));

  const prompt = "── Wednesday, December 31, 1969 ──\nhi";
  assert.equal(recorded[0]!.inputTokens, countTokens(first) + countTokens(prompt));
  assert.equal(recorded[1]!.inputTokens, countTokens(second) + countTokens(prompt));
});

test("the cwd pi appends to the system prompt is one constant path per agent", () => {
  assert.equal(stableCwd("pi"), join(tmpdir(), "pi-cwd"));
  assert.equal(stableCwd("pi"), stableCwd("pi"));
});

test("each turn removes its agent directory and reuses one constant cwd", async () => {
  const prefix = `pi-turn-${process.pid}`;
  const agent = createAgent({ tempDirPrefix: prefix });
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];

  await runIgnoringPromptError(agent, recordingTurn("BASE", recorded, "cleanup"));
  await runIgnoringPromptError(agent, recordingTurn("BASE", recorded, "cleanup-2"));

  assert.equal(countTempDirs(`${prefix}-agent-`), 0);
  assert.equal(countTempDirs(`${prefix}-cwd`), 1);
  rmSync(stableCwd(prefix), { recursive: true, force: true });
});

test("a squatted shared cwd falls back to a per-turn cwd that is removed afterwards", async () => {
  const prefix = `pi-squat-${process.pid}`;
  writeFileSync(stableCwd(prefix), "not a directory");
  const agent = createAgent({ tempDirPrefix: prefix });
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];

  await runIgnoringPromptError(agent, recordingTurn("BASE", recorded, "squat"));

  assert.equal(recorded.length, 1, "the turn still reached the model call");
  assert.equal(countTempDirs(`${prefix}-cwd-`), 0);
  assert.equal(countTempDirs(`${prefix}-agent-`), 0);
  rmSync(stableCwd(prefix), { force: true });
});

test("the agent exposes no session-reset hook after removing session state", () => {
  assert.equal(createAgent().resetSession, undefined);
});

function ackStream(text: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        model: "x",
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function ackRequest(input: string | URL | Request, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body ?? "{}"));
  return { url, headers, body };
}

test("ack emoji keeps working on a non-Anthropic base model when an Anthropic key is present", async () => {
  const agent = createAgent({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-test" }),
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; model: unknown; thinking: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { url, body } = await ackRequest(input, init);
    calls.push({ url, model: body.model, thinking: body.thinking });
    return ackStream('{"emoji":"eyes"}');
  }) as typeof globalThis.fetch;
  try {
    const picked = await agent.pickAckEmoji?.("ship it", ["eyes", "rocket"]);
    assert.equal(picked, "eyes", "the pick still lands even though the base model is OpenAI");
    assert.equal(calls.length, 1, "the Anthropic ack call was actually attempted");
    assert.match(calls[0]!.url, /anthropic/, "it went to the Anthropic API");
    assert.equal(calls[0]!.model, "claude-haiku-5-5", "it used the Anthropic auxiliary, not the OpenAI judge model");
    assert.deepEqual(calls[0]!.thinking, { type: "disabled" }, "the 64-token pick never spends its budget thinking");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ack emoji stays home when the deployment has no Anthropic key at all", async () => {
  const agent = createAgent({
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
    assert.equal(await agent.pickAckEmoji?.("ship it", ["eyes"]), undefined);
    assert.equal(called, 0, "no Anthropic call without an Anthropic key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("model utilities resolve provider credentials for every call", async () => {
  let resolutions = 0;
  const agent = createAgent({
    resolveProviderKeys: async () => {
      resolutions += 1;
      return {};
    },
  });

  assert.equal(await agent.oneShot?.("system", "first"), undefined);
  assert.equal(await agent.oneShot?.("system", "second"), undefined);
  assert.equal(resolutions, 2);
});

test("prior-turn bootstrap reaches the model before the first prompt", async () => {
  const agent = createAgent({ apiKey: "sk-test" });
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const turn = recordingTurn("BASE", [], "prior-bootstrap");
  turn.priorTurns = [
    { role: "assistant", text: "I opened this thread with the release result" },
    { role: "user", name: "Jordan", text: "tell me more" },
  ];
  try {
    await runIgnoringPromptError(agent, turn);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(bodies.length > 0);
  assert.match(bodies[0]!, /release result/);
  assert.match(bodies[0]!, /tell me more/);
});

test("ack emoji on a Claude subscription token signs the call as a subscription request", async () => {
  const agent = createAgent({
    defaultModelId: "claude-sonnet-5",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-oat01-ack" }),
  });
  const realFetch = globalThis.fetch;
  const seen: Array<{ headers: Headers; system: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { headers, body } = await ackRequest(input, init);
    seen.push({ headers, system: body.system });
    return ackStream('{"emoji":"eyes"}');
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await agent.pickAckEmoji?.("ship it", ["eyes"]), "eyes");
    assert.equal(seen[0]!.headers.get("authorization"), "Bearer sk-ant-oat01-ack");
    assert.equal(seen[0]!.headers.get("x-api-key"), null);
    assert.match(seen[0]!.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
    assert.match(JSON.stringify(seen[0]!.system), /You are Claude Code/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an ack emoji provider failure surfaces its error instead of reading as a declined pick", async () => {
  const agent = createAgent({
    defaultModelId: "claude-sonnet-5",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-oat01-revoked" }),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "revoked" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  try {
    await assert.rejects(async () => agent.pickAckEmoji?.("ship it", ["eyes"]), /authentication_error|revoked/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
