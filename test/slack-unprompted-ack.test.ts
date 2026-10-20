import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnHandler } from "../src/slack/turn-handler.ts";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import { createThreadTracker, createDeduper } from "../src/slack/lib.ts";
import type { BotIdentity, Directory } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT", botHandle: "qm" } as BotIdentity;
const actor = { externalId: "U1", displayName: "Teammate" };
const directory = {
  classifyUserCached: async () => ({ actor }),
} as unknown as Directory;

function harness(run: (hooks: any) => Promise<unknown>) {
  const reactions: string[] = [];
  const posts: string[] = [];
  const postArgs: Array<Record<string, unknown>> = [];
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
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args.text as string);
        postArgs.push(args);
        return { ts: `9${posts.length}.0` };
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
  };
  const handler = createTurnHandler({
    core: {
      stageBlob: async () => ({ blobId: "b", sizeBytes: 0 }),
      reportRunEditRef: async () => {},
    },
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
  return { handler, client, followup, reactions, posts, postArgs, turns };
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

test("an answered followup's ack clears as soon as QM posts into the thread", async () => {
  const h = harness(async (hooks) => {
    hooks.onReplying?.();
    await new Promise((r) => setTimeout(r, 2_200));
    hooks.onSurfacePosted?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
    return { status: "ok", reply: "" };
  });
  await h.handler.handleIncoming(h.followup, h.client);
  assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
});

test("an answered followup whose reply post fails still clears its ack", async () => {
  const h = harness(async (hooks) => {
    await hooks.onQueued?.("r1");
    hooks.onReplying?.();
    await new Promise((r) => setTimeout(r, 2_200));
    return { status: "ok", reply: "Staging is green." };
  });
  h.client.chat.postMessage = async () => {
    throw new Error("slack 500");
  };
  await h.handler.handleIncoming(h.followup, h.client);
  assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
});

test("synthetic reaction turns never receive ack hooks", async () => {
  let hooksSeen: string[] = [];
  const h = harness(async (hooks) => {
    hooksSeen = Object.keys(hooks).filter((k) => k.startsWith("on") && typeof hooks[k] === "function");
    return { status: "silent" };
  });
  await h.handler.handleIncoming({ ...h.followup, synthetic: true }, h.client);
  assert.ok(!hooksSeen.includes("onReplying"));
  assert.ok(!hooksSeen.includes("onFirstBlock"));
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

test("a mention-only thread reply starts a turn with the tag intact", async () => {
  const h = harness(async () => ({ status: "ok", reply: "On it." }));
  await h.handler.handleIncoming({ ...h.followup, unprompted: false, rawText: "<@UBOT>" }, h.client);
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].text, "@qm");
  assert.deepEqual(h.posts, ["On it."]);
});

test("the bot's own mention reaches the agent instead of being stripped", async () => {
  const h = harness(async () => ({ status: "ok", reply: "Done." }));
  await h.handler.handleIncoming({ ...h.followup, unprompted: false, rawText: "<@UBOT> check &amp; report" }, h.client);
  assert.equal(h.turns[0].text, "@qm check & report");
});
