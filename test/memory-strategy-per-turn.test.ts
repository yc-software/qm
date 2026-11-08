import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStrategy, parseMemoryStrategyKind } from "../src/memory/strategy.ts";
import { createPerTurnStrategy, MEMORY_EXTRACTION_PROMPT, parseFacts } from "../src/memory/strategies/per-turn.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import type { ModelUtilities } from "../src/agent/agent.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { settle } from "./support/settle.ts";

const SCOPE = "user:U1";

function freshMemory() {
  return { memory: createPostgresMemoryService(testDatabaseUrl()) };
}

test("per-turn via oneShot sends the extraction prompt + the exact user/reply framing the old extractor sent", async () => {
  const calls: Array<{ system: string; prompt: string }> = [];
  const agent: ModelUtilities = {
    oneShot(system, prompt) {
      calls.push({ system, prompt });
      return Promise.resolve("- Prefers terse replies\n* Working on the Q3 launch\nnot a bullet");
    },
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ agent, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.system, MEMORY_EXTRACTION_PROMPT);
  assert.equal(calls[0]!.prompt, "User said:\nhi\n\nAssistant replied:\nhello");
  const body = await memory.read(SCOPE);
  assert.match(body, /Prefers terse replies/);
  assert.match(body, /Working on the Q3 launch/);
  assert.doesNotMatch(body, /not a bullet/);
});

test("parseFacts: bullets in, NONE/empty/prose out", () => {
  assert.deepEqual(parseFacts("- a\n* b\n  - c \nplain"), ["a", "b", "c"]);
  assert.deepEqual(parseFacts("NONE"), []);
  assert.deepEqual(parseFacts("none"), []);
  assert.deepEqual(parseFacts(""), []);
  assert.deepEqual(parseFacts("-"), []);
});

test("per-turn swallows extraction failures and captures nothing", async () => {
  const agent: ModelUtilities = {
    oneShot: () => Promise.reject(new Error("model down")),
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ agent, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });
  assert.equal(await memory.read(SCOPE), "", "nothing captured");
});

test("per-turn does not capture when the model says NONE", async () => {
  const agent: ModelUtilities = {
    oneShot: () => Promise.resolve("NONE"),
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ agent, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });
  assert.equal(await memory.read(SCOPE), "");
});

test("MEMORY_STRATEGY parsing: per-turn is the default, agent-only disables post-turn extraction", () => {
  assert.equal(parseMemoryStrategyKind(undefined), "per-turn");
  assert.equal(parseMemoryStrategyKind("per-turn"), "per-turn");
  assert.equal(parseMemoryStrategyKind("bogus"), "per-turn");
  assert.equal(parseMemoryStrategyKind("agent-only"), "agent-only");

  const { memory } = freshMemory();
  const agent = createMockAgent();
  assert.equal(createMemoryStrategy("agent-only", { agent, memory }).strategy.onTurnEnd, undefined);
  assert.ok(createMemoryStrategy("per-turn", { agent, memory }).strategy.onTurnEnd);
});

test("automatic capture carries the full turn and delivery context", async () => {
  const captures: Array<Parameters<ReturnType<typeof freshMemory>["memory"]["capture"]>> = [];
  const { memory } = freshMemory();
  const wrapped = {
    ...memory,
    async capture(...args: Parameters<typeof memory.capture>) {
      captures.push(args);
      return memory.capture(...args);
    },
  };
  const strategy = createPerTurnStrategy({
    agent: { oneShot: () => Promise.resolve("- Durable fact") },
    memory: wrapped,
  });
  await strategy.onTurnEnd!({
    scopeId: SCOPE,
    conversationScopeId: "channel:C1",
    actorId: "U1",
    sessionId: "session-1",
    idempotencyKey: "run-1",
    input: "question",
    reply: "answer",
  });
  assert.deepEqual(captures[0]?.[3], { actorId: "U1", context: "conversation" });
  assert.deepEqual(captures[0]?.[4], {
    mode: "automatic",
    sensitivity: "unknown",
    conversationScopeId: "channel:C1",
    input: "question",
    reply: "answer",
    sessionId: "session-1",
    idempotencyKey: "run-1",
  });
});
test("turns of one session answered to different audiences are captured apart, each under its own audience", async () => {
  const captures: Array<Parameters<ReturnType<typeof freshMemory>["memory"]["capture"]>> = [];
  const { memory } = freshMemory();
  const wrapped = {
    ...memory,
    async capture(...args: Parameters<typeof memory.capture>) {
      captures.push(args);
      return memory.capture(...args);
    },
  };
  const strategy = createPerTurnStrategy({
    agent: { oneShot: () => Promise.resolve("- Durable fact") },
    memory: wrapped,
    captureQuietMs: 30,
  });
  const turn = { scopeId: "personal:U1", actorId: "U1", sessionId: "session-1", reply: "answer" };
  await strategy.onTurnEnd!({ ...turn, audienceScopeId: "personal:U1", input: "private question" });
  await strategy.onTurnEnd!({ ...turn, input: "question answered to a channel" });
  await settle(async () => captures.length === 2);

  assert.deepEqual(
    captures
      .map(([, , , , context]) => ({ input: context?.input, audienceScopeId: context?.audienceScopeId }))
      .sort((x, y) => String(x.input).localeCompare(String(y.input))),
    [
      { input: "private question", audienceScopeId: "personal:U1" },
      { input: "question answered to a channel", audienceScopeId: undefined },
    ],
  );
});
