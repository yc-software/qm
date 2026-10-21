import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createPerTurnStrategy } from "../src/memory/strategies/per-turn.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import { scopeId } from "../src/types.ts";

const ACTOR = "U1";
const CHANNEL = scopeId("channel", "C9");
const GROUP = scopeId("group", "G9");
const DM = scopeId("personal", ACTOR);
const PERSONAL = scopeId("personal", ACTOR);

function freshMemory() {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "mcc-")));
  return { memory: createMemoryService(workspace) };
}

const INPUT = "remember that my task list is ship the launch";
const REPLY = "Noted.";

for (const origin of [CHANNEL, GROUP, DM]) {
  test(`automatic capture writes only to ${origin} and leaves existing notebooks untouched`, async () => {
    const { memory } = freshMemory();
    await memory.capture(PERSONAL, ["Existing fact"], Date.now());
    const before = await memory.read(PERSONAL);
    const strategy = createPerTurnStrategy({ harness: createMockHarness().models, memory });
    await strategy.onTurnEnd!({ scopeId: origin, input: INPUT, reply: REPLY, actorId: ACTOR });
    assert.match(await memory.read(origin), /task list is ship the launch/);
    if (origin !== PERSONAL) assert.equal(await memory.read(PERSONAL), before);
    else assert.equal((await memory.read(PERSONAL)).split("task list is ship the launch").length - 1, 1);
  });
}

test("redirected capture writes only to the resolved target, not the speaker's notebook", async () => {
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness: createMockHarness().models, memory });
  await strategy.onTurnEnd!({
    scopeId: "personal:U2",
    conversationScopeId: CHANNEL,
    input: INPUT,
    reply: REPLY,
    actorId: ACTOR,
  });
  assert.match(await memory.read("personal:U2"), /task list is ship the launch/);
  assert.equal(await memory.read(PERSONAL), "");
  assert.equal(await memory.read(CHANNEL), "");
});

test("burst debounce: turns within the quiet window flush as one extraction after it elapses", async () => {
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness: createMockHarness().models, memory, captureQuietMs: 30 });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact one is alpha", reply: REPLY, actorId: ACTOR });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact two is beta", reply: REPLY, actorId: ACTOR });

  assert.equal(await memory.read(DM), "", "nothing captured before the quiet window elapses");
  await new Promise((r) => setTimeout(r, 120));
  const body = await memory.read(DM);
  assert.match(body, /fact one is alpha/);
  assert.match(body, /fact two is beta/);
});

test("burst debounce: a full burst flushes immediately at captureMaxTurns", async () => {
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({
    harness: createMockHarness().models,
    memory,
    captureQuietMs: 60_000,
    captureMaxTurns: 2,
  });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact one is alpha", reply: REPLY, actorId: ACTOR });
  await strategy.onTurnEnd!({ scopeId: DM, input: "remember that fact two is beta", reply: REPLY, actorId: ACTOR });

  const body = await memory.read(DM);
  assert.match(body, /fact one is alpha/, "cap reached — no waiting on the quiet window");
  assert.match(body, /fact two is beta/);
});

test("burst debounce: different speakers in one channel keep separate bursts in the channel", async () => {
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness: createMockHarness().models, memory, captureQuietMs: 30 });
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
  await new Promise((r) => setTimeout(r, 120));

  assert.match(await memory.read(CHANNEL), /ship the launch/);
  assert.match(await memory.read(CHANNEL), /write the memo/);
  assert.equal(await memory.read(PERSONAL), "");
  assert.equal(await memory.read(scopeId("personal", "U2")), "");
});

test("a channel turn by a system actor captures nothing anywhere", async () => {
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness: createMockHarness().models, memory });
  await strategy.onTurnEnd!({ scopeId: CHANNEL, input: INPUT, reply: REPLY, actorId: "system:ambient:acme" });

  assert.equal(await memory.read(CHANNEL), "", "origin scope receives nothing");
  assert.equal(
    await memory.read(scopeId("personal", "system:ambient:acme")),
    "",
    "no personal drawer for the platform actor",
  );
});

test("an autonomous (triggered) channel turn captures nothing, even for a human actor", async () => {
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness: createMockHarness().models, memory });
  await strategy.onTurnEnd!({ scopeId: CHANNEL, input: INPUT, reply: REPLY, actorId: ACTOR, autonomous: true });

  assert.equal(await memory.read(CHANNEL), "", "origin scope receives nothing on a triggered wake");
  assert.equal(await memory.read(PERSONAL), "", "owner notebook remains untouched on a triggered wake");
});
