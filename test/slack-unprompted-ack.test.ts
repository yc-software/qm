import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnHandler } from "../src/slack/turn-handler.ts";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import { createThreadTracker, createDeduper } from "../src/slack/lib.ts";
import type { BotIdentity, Directory } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;
const actor = { externalId: "U1", displayName: "Teammate" };
const directory = {
  classifyUserCached: async () => ({ actor }),
} as unknown as Directory;

function harness(run: (hooks: any) => Promise<unknown>) {
  const reactions: string[] = [];
  const posts: string[] = [];
  const turns: any[] = [];
  const client = {
    reactions: {
      add: async ({ name, timestamp }: { name: string; timestamp: string }) => {
        reactions.push(`+${name}@${timestamp}`);
      },
      remove: async ({ name, timestamp }: { name: string; timestamp: string }) => {
        reactions.push(`-${name}@${timestamp}`);
      },
    },
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        posts.push(text);
        return { ts: `9${posts.length}.0` };
      },
    },
  };
  const handler = createTurnHandler({
    core: { stageBlob: async () => ({ blobId: "b", sizeBytes: 0 }) },
    flow: {
      inFlightRuns: { add() {}, delete() {}, has: () => false },
      inFlightRunByThread: { get() {}, set() {}, clear() {} },
      ackRunDelivery() {},
      callCore: async (turn: any, hooks: any) => {
        turns.push(turn);
        return run(hooks);
      },
    },
    directory,
    mirror: { mirrorMessageEvent: async () => {} },
    serializer: createConversationSerializer({
      ids,
      directory,
      externalParticipantsEnabled: async () => false,
      readHistory: async () => {
        throw new Error("history unavailable");
      },
    }),
    ackEmoji: {
      refreshAckEmoji() {},
      ackPickCandidates: () => [],
      requestAckEmoji: async () => undefined,
    },
    ackEmojiCandidates: () => ["eyes"],
    ids,
    threads: createThreadTracker(),
    deduper: createDeduper(),
    externalParticipantsEnabled: async () => false,
  } as unknown as Parameters<typeof createTurnHandler>[0]);
  const followup = {
    kind: "channel" as const,
    channel: "C1",
    userId: "U1",
    rawText: "can you also check staging?",
    files: [],
    threadTs: "1.000",
    ts: "2.000",
    unprompted: true,
    prefetched: { actor, info: { id: "C1", name: "eng" } as any, audience: [actor] },
  };
  return { handler, client, followup, reactions, posts, turns };
}

test("an unmentioned thread followup QM answers gets the ack reaction added then cleared", async () => {
  const h = harness(async (hooks) => {
    hooks.onReplying?.();
    await new Promise((r) => setTimeout(r, 2_200));
    return { status: "ok", reply: "Staging is green." };
  });
  await h.handler.handleIncoming(h.followup, h.client);
  assert.equal(h.turns[0].unprompted, true);
  assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
  assert.deepEqual(h.posts, ["Staging is green."]);
});

test("an unmentioned followup QM starts answering posts its early first block like a direct request", async () => {
  const h = harness(async (hooks) => {
    hooks.onFirstBlock?.("Checking staging now.");
    await new Promise((r) => setTimeout(r, 50));
    return { status: "ok", reply: "Staging is green." };
  });
  await h.handler.handleIncoming(h.followup, h.client);
  assert.deepEqual(h.posts, ["Checking staging now.", "Staging is green."]);
  assert.deepEqual(h.reactions, []);
});

for (const outcome of [{ status: "silent" }, { status: "react", reactions: ["thumbsup"] }] as const) {
  test(`an unmentioned followup QM declines (${outcome.status}) gets no ack reaction`, async () => {
    const h = harness(async () => {
      await new Promise((r) => setTimeout(r, 2_200));
      return outcome;
    });
    await h.handler.handleIncoming(h.followup, h.client);
    assert.deepEqual(h.reactions, outcome.status === "react" ? ["+thumbsup@2.000"] : []);
    assert.deepEqual(h.posts, []);
  });
}

test("waitRun signals replying only once the run has passed detection and begun its reply", async () => {
  const { createSlackCoreClient } = await import("../src/api/slack-core-client.ts");
  const { createTurnStream } = await import("../src/runs/turn-stream.ts");
  const turnStream = createTurnStream();
  let polls = 0;
  let replying = 0;
  const client = createSlackCoreClient({
    turnStream,
    runs: {
      onTerminal() {},
      get: async () => {
        polls++;
        if (polls === 2) turnStream.begin("r1");
        return { id: "r1", status: polls >= 4 ? "done" : "running", attempts: 1 };
      },
    },
    tasks: { list: async () => [] },
    app: { getRun: async () => ({ result: { status: "ok", reply: "done" } }) },
  } as any);
  await client.waitRun("r1", {
    onReplying: () => {
      assert.ok(polls >= 2, "not before the reply begins");
      replying++;
    },
  });
  assert.equal(replying, 1);
});
