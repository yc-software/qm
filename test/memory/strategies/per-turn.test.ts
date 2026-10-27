import assert from "node:assert/strict";
import {
  createPerTurnStrategy,
  MEMORY_EXTRACTION_PROMPT,
  parseFacts,
} from "../../../src/memory/strategies/per-turn.ts";
import { createPgPool } from "../../../src/persistence/pg-pool.ts";
import { createMockHarness } from "../../support/mock-harness.ts";
import { scopeId } from "../../../src/types.ts";
import { createPostgresMemoryService } from "../../../src/memory/postgres-memory-service.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";
import { test } from "node:test";
import type { HarnessModelUtilities } from "../../../src/harness/harness.ts";

const SCOPE = "user:U1";

function freshMemory() {
  return { memory: createPostgresMemoryService(testDatabaseUrl()) };
}

test("per-turn via oneShot sends the extraction prompt + the exact user/reply framing the old extractor sent", async () => {
  const calls: Array<{ system: string; prompt: string }> = [];
  const harness: HarnessModelUtilities = {
    oneShot(system, prompt) {
      calls.push({ system, prompt });
      return Promise.resolve("- Prefers terse replies\n* Working on the Q3 launch\nnot a bullet");
    },
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.system, MEMORY_EXTRACTION_PROMPT);
  assert.equal(calls[0]!.prompt, "User said:\nhi\n\nAssistant replied:\nhello");
  const body = await memory.read(SCOPE);
  assert.match(body, /Prefers terse replies/);
  assert.match(body, /Working on the Q3 launch/);
  assert.doesNotMatch(body, /not a bullet/);
});

test("autonomous and system-actor turns capture nothing; only a human turn extracts", async () => {
  const systems: string[] = [];
  const harness: HarnessModelUtilities = {
    oneShot(system) {
      systems.push(system);
      return Promise.resolve("NONE");
    },
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "trigger", reply: "queued", actorId: "system:ambient:acme" });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "[cron wake]", reply: "done", actorId: "U1", autonomous: true });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello", actorId: "U1" });

  assert.deepEqual(systems, [MEMORY_EXTRACTION_PROMPT], "one extraction, for the human turn only");
});

test("automatic capture sees what the notebook already holds, so an explicit save is not restated", async () => {
  const prompts: string[] = [];
  const harness: HarnessModelUtilities = {
    oneShot(_system, prompt) {
      prompts.push(prompt);
      return Promise.resolve(
        prompt.includes("- Regan's QA fruit is kumquat\n")
          ? "NONE"
          : '- User asked to remember: "Regan\'s QA fruit is kumquat"',
      );
    },
  };
  const { memory } = freshMemory();
  const scope = "user:U-known-facts";
  await memory.capture(scope, ["Regan's QA fruit is kumquat"], 1_000, "U1", { mode: "explicit" });
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({
    scopeId: scope,
    input: "remember my QA fruit is kumquat",
    reply: "Saved.",
    actorId: "U1",
  });

  assert.equal(
    prompts[0],
    "Already remembered:\n- Regan's QA fruit is kumquat\n\n---\n\nUser said:\nremember my QA fruit is kumquat\n\nAssistant replied:\nSaved.",
  );
  assert.deepEqual(
    (await memory.facts!(scope)).map((fact) => fact.text),
    ["Regan's QA fruit is kumquat"],
  );
});

test("parseFacts: bullets in, NONE/empty/prose out", () => {
  assert.deepEqual(parseFacts("- a\n* b\n  - c \nplain"), ["a", "b", "c"]);
  assert.deepEqual(parseFacts("NONE"), []);
  assert.deepEqual(parseFacts("none"), []);
  assert.deepEqual(parseFacts(""), []);
  assert.deepEqual(parseFacts("-"), []);
});

test("per-turn surfaces extraction failures and captures nothing", async () => {
  const harness: HarnessModelUtilities = {
    oneShot: () => Promise.reject(new Error("model down")),
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await assert.rejects(strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" }), /model down/);
  assert.equal(await memory.read(SCOPE), "", "nothing captured");
});

test("per-turn does not capture when the model says NONE", async () => {
  const harness: HarnessModelUtilities = {
    oneShot: () => Promise.resolve("NONE"),
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });
  assert.equal(await memory.read(SCOPE), "");
});

test("debounced: an autonomous turn is skipped and never joins the live actor's burst", async () => {
  const calls: string[] = [];
  const harness: HarnessModelUtilities = {
    oneShot(_system, prompt) {
      calls.push(prompt);
      return Promise.resolve("NONE");
    },
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({
    harness,
    memory,
    captureQuietMs: 30,
    captureMaxTurns: 10,
    databaseUrl: testDatabaseUrl(),
  });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "[cron wake]", reply: "done", actorId: "U1", autonomous: true });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello", actorId: "U1" });
  // The flush first reads the notebook's known facts, which can wait on a cold test database.
  const deadline = Date.now() + 5_000;
  while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 120));

  assert.deepEqual(calls, ["User said:\nhi\n\nAssistant replied:\nhello"], "one flush, the live turn only");
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
    harness: { oneShot: () => Promise.resolve("- Durable fact") },
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
  assert.deepEqual(captures[0]?.[4], {
    mode: "automatic",
    sensitivity: "unknown",
    actorId: "U1",
    conversationScopeId: "channel:C1",
    input: "question",
    reply: "answer",
    sessionId: "session-1",
    idempotencyKey: "run-1",
  });
});

const ACTOR = "U1";
const CHANNEL = scopeId("channel", "C9");
const GROUP = scopeId("group", "G9");
const DM = scopeId("personal", ACTOR);
const PERSONAL = scopeId("personal", ACTOR);

function fresh(opts: { captureQuietMs?: number; captureMaxTurns?: number } = {}) {
  const databaseUrl = testDatabaseUrl();
  const memory = createPostgresMemoryService(databaseUrl);
  const strategy = createPerTurnStrategy({ harness: createMockHarness().models, memory, databaseUrl, ...opts });
  return { databaseUrl, memory, strategy };
}

const INPUT = "remember that my task list is ship the launch";
const REPLY = "Noted.";

async function flushed(read: () => Promise<string>, patterns: RegExp[]): Promise<string> {
  let body = await read();
  for (let attempt = 0; attempt < 300 && !patterns.every((p) => p.test(body)); attempt++) {
    await new Promise((r) => setTimeout(r, 10));
    body = await read();
  }
  return body;
}

for (const origin of [CHANNEL, GROUP, DM]) {
  test(`automatic capture writes only to ${origin} and leaves existing notebooks untouched`, async () => {
    const { memory, strategy } = fresh();
    await memory.capture(PERSONAL, ["Existing fact"], Date.now());
    const before = await memory.read(PERSONAL);
    await strategy.onTurnEnd!({ scopeId: origin, input: INPUT, reply: REPLY, actorId: ACTOR });
    assert.match(
      await flushed(() => memory.read(origin), [/task list is ship the launch/]),
      /task list is ship the launch/,
    );
    if (origin !== PERSONAL) assert.equal(await memory.read(PERSONAL), before);
    else assert.equal((await memory.read(PERSONAL)).split("task list is ship the launch").length - 1, 1);
  });
}

test("redirected capture writes only to the resolved target, not the speaker's notebook", async () => {
  const { memory, strategy } = fresh();
  await strategy.onTurnEnd!({
    scopeId: "personal:U2",
    conversationScopeId: CHANNEL,
    input: INPUT,
    reply: REPLY,
    actorId: ACTOR,
  });
  assert.match(
    await flushed(() => memory.read("personal:U2"), [/task list is ship the launch/]),
    /task list is ship the launch/,
  );
  assert.equal(await memory.read(PERSONAL), "");
  assert.equal(await memory.read(CHANNEL), "");
});

test("burst debounce: turns within the quiet window flush as one extraction after it elapses", async () => {
  const { memory, strategy } = fresh({ captureQuietMs: 30 });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact one is alpha", reply: REPLY, actorId: ACTOR });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact two is beta", reply: REPLY, actorId: ACTOR });

  assert.equal(await memory.read(DM), "", "nothing captured before the quiet window elapses");
  const body = await flushed(() => memory.read(DM), [/fact one is alpha/, /fact two is beta/]);
  assert.match(body, /fact one is alpha/);
  assert.match(body, /fact two is beta/);
});

test("burst debounce: a full burst flushes immediately at captureMaxTurns", async () => {
  const { memory, strategy } = fresh({ captureQuietMs: 60_000, captureMaxTurns: 2 });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact one is alpha", reply: REPLY, actorId: ACTOR });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact two is beta", reply: REPLY, actorId: ACTOR });

  const body = await flushed(() => memory.read(DM), [/fact one is alpha/, /fact two is beta/]);
  assert.match(body, /fact one is alpha/, "cap reached — no waiting on the quiet window");
  assert.match(body, /fact two is beta/);
});

test("burst debounce: different speakers in one channel keep separate bursts in the channel", async () => {
  const { memory, strategy } = fresh({ captureQuietMs: 30 });
  await strategy.onTurnEnd!({
    scopeId: CHANNEL,
    input: "remember that my task list is ship the launch",
    reply: REPLY,
    actorId: ACTOR,
  });
  await strategy.onTurnEnd!({
    scopeId: CHANNEL,
    input: "remember that my task list is write the memo",
    reply: REPLY,
    actorId: "U2",
  });
  await flushed(() => memory.read(CHANNEL), [/ship the launch/, /write the memo/]);

  assert.match(await memory.read(CHANNEL), /ship the launch/);
  assert.match(await memory.read(CHANNEL), /write the memo/);
  assert.equal(await memory.read(PERSONAL), "");
  assert.equal(await memory.read(scopeId("personal", "U2")), "");
});

test("a channel turn by a system actor captures nothing anywhere", async () => {
  const { memory, strategy } = fresh();
  await strategy.onTurnEnd!({ scopeId: CHANNEL, input: INPUT, reply: REPLY, actorId: "system:ambient:acme" });

  assert.equal(await memory.read(CHANNEL), "", "origin scope receives nothing");
  assert.equal(
    await memory.read(scopeId("personal", "system:ambient:acme")),
    "",
    "no personal drawer for the platform actor",
  );
});

test("an autonomous (triggered) channel turn captures nothing, even for a human actor", async () => {
  const { memory, strategy } = fresh();
  await strategy.onTurnEnd!({ scopeId: CHANNEL, input: INPUT, reply: REPLY, actorId: ACTOR, autonomous: true });

  assert.equal(await memory.read(CHANNEL), "", "origin scope receives nothing on a triggered wake");
  assert.equal(await memory.read(PERSONAL), "", "owner notebook remains untouched on a triggered wake");
});

test("burst debounce: turns appended through two instances flush once, as one extraction", async () => {
  const { memory, databaseUrl } = fresh();
  const prompts: string[] = [];
  const harness = {
    oneShot: async (_system: string, prompt: string) => {
      prompts.push(prompt);
      return "SENSITIVITY: ordinary\n- Combined fact";
    },
  };
  const one = createPerTurnStrategy({ harness, memory, captureQuietMs: 30, databaseUrl });
  const two = createPerTurnStrategy({ harness, memory, captureQuietMs: 30, databaseUrl });
  await one.onTurnEnd!({ scopeId: DM, input: "first", reply: REPLY, actorId: ACTOR });
  await two.onTurnEnd!({ scopeId: DM, input: "second", reply: REPLY, actorId: ACTOR });
  await flushed(() => memory.read(DM), [/Combined fact/]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(prompts.length, 1, "the first instance's timer yields to the later append");
  assert.match(prompts[0]!, /first[\s\S]*second/);
});

test("a turn's capture is on disk once onTurnEnd resolves, before any extraction runs", async () => {
  const databaseUrl = testDatabaseUrl();
  const memory = createPostgresMemoryService(databaseUrl);
  let extractions = 0;
  const harness: HarnessModelUtilities = {
    oneShot() {
      extractions++;
      return Promise.resolve("NONE");
    },
  };
  const strategy = createPerTurnStrategy({ harness, memory, databaseUrl });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact one is alpha", reply: REPLY, actorId: ACTOR });
  const { q } = createPgPool(databaseUrl);
  assert.equal((await q(`SELECT turns FROM memory_capture_pending`)).length, 1, "the burst is durable at return");
  assert.equal(extractions, 0, "the caller never waits on the model");
  for (let attempt = 0; attempt < 300 && extractions === 0; attempt++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(extractions, 1);
});

test("burst debounce: the sweep finishes a burst whose instance went away", async () => {
  const { memory, strategy, databaseUrl } = fresh({ captureQuietMs: 30 });
  const { q } = createPgPool(databaseUrl);
  await q(
    `INSERT INTO memory_capture_pending (id, scope_id, conversation_scope_id, actor_id, turns, token, at)
     VALUES ('orphan', $1, $1, $2, $3, 'left-behind', $4)`,
    [DM, ACTOR, JSON.stringify([{ input: "remember that fact one is alpha", reply: REPLY }]), Date.now() - 10 * 60_000],
  );
  await strategy.sweep();
  assert.match(await memory.read(DM), /fact one is alpha/);
  assert.deepEqual(await q(`SELECT id FROM memory_capture_pending`), []);
});
