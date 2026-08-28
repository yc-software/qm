import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSurfaceContextFulfiller } from "../src/slack/surface-context.ts";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import type { SurfaceContextQuery } from "../src/types.ts";

const HISTORY = [
  { ts: "4.000000", user: "U2", text: "newest top-level" },
  { ts: "1.000000", user: "U1", text: "thread parent", reply_count: 2 },
];

const THREADS: Record<string, unknown[]> = {
  "1.000000": [
    { ts: "1.000000", user: "U1", text: "thread parent", reply_count: 2 },
    { ts: "2.000000", thread_ts: "1.000000", user: "U2", text: "first reply" },
    { ts: "3.000000", thread_ts: "1.000000", user: "U1", text: "second reply" },
  ],
};

function harness() {
  const fulfilled: unknown[] = [];
  const core = {
    fulfillContextRequest: async (_id: string, outcome: unknown) => void fulfilled.push(outcome),
  };
  const directory = {
    classifyUserCached: async (_client: unknown, id: string) => ({ actor: { displayName: `name-${id}` } }),
    getChannelInfo: async () => ({ is_member: true }),
  };
  const serializer = createConversationSerializer({
    ids: {
      ownTeamId: "T1",
      botUserId: "UBOT",
      ownBotId: "BBOT",
      botHandle: "qm",
      ownWorkspaceUrl: "",
      identityMode: "email",
    },
    directory: directory as never,
    externalParticipantsEnabled: async () => true,
  });
  const historyCalls: Array<Record<string, unknown>> = [];
  const replyCalls: string[] = [];
  const client = {
    conversations: {
      history: async (args: Record<string, unknown>) => {
        historyCalls.push(args);
        return { messages: HISTORY };
      },
      replies: async ({ ts }: { ts: string }) => {
        replyCalls.push(ts);
        const messages = THREADS[ts];
        if (!messages) {
          const err = new Error("thread_not_found") as Error & { data: { error: string } };
          err.data = { error: "thread_not_found" };
          throw err;
        }
        return { messages };
      },
    },
  };
  const f = createSurfaceContextFulfiller({
    core: core as never,
    bridge: {} as never,
    directory: directory as never,
    serializer,
    botToken: "xoxb-test",
    clientOptions: {},
  });
  const pull = async (query: SurfaceContextQuery) => {
    await f.fulfillSurfaceContext(client, {
      id: "req",
      source: "slack",
      createdAt: Date.now(),
      status: "pending",
      query,
    });
    return (fulfilled[0] as { result?: { messages: Array<{ ts: string; text: string; threadTs?: string }> }; error?: string })!;
  };
  return { pull, historyCalls, replyCalls };
}

describe("surface-context channel reads", () => {
  it("expands recent threads when reading a channel top-level, not just parents", async () => {
    const { pull, replyCalls } = harness();
    const outcome = await pull({ conversationTarget: "C1", count: 50 });
    assert.deepEqual(replyCalls, ["1.000000"], "each recent thread parent is expanded exactly once");
    assert.deepEqual(
      outcome.result!.messages.map((m) => m.ts),
      ["1.000000", "2.000000", "3.000000", "4.000000"],
      "thread replies ride along with the top-level history, in order",
    );
    assert.equal(outcome.result!.messages[1]!.threadTs, "1.000000", "a reply carries its parent's ts");
  });

  it("skips thread expansion on a paged (before) read, keeping the cursor a pure history walk", async () => {
    const { pull, historyCalls, replyCalls } = harness();
    await pull({ conversationTarget: "C1", count: 50, before: "4.000000" });
    assert.equal(historyCalls[0]!.latest, "4.000000");
    assert.deepEqual(replyCalls, [], "no replies calls on a paged scan");
  });

  it("pulls exactly and only the named thread when the query carries a threadTs", async () => {
    const { pull, historyCalls, replyCalls } = harness();
    const outcome = await pull({ channelId: "C1", threadTs: "1.000000", count: 50 });
    assert.deepEqual(replyCalls, ["1.000000"], "one replies call, no duplicate via expansion");
    assert.deepEqual(historyCalls, [], "no channel history competes with the thread for the window");
    assert.deepEqual(
      outcome.result!.messages.map((m) => m.text),
      ["thread parent", "first reply", "second reply"],
    );
  });

  it("names the threadTs problem instead of failing the whole read when the thread doesn't exist", async () => {
    const { pull } = harness();
    const outcome = await pull({ channelId: "C1", threadTs: "9.999999", count: 50 });
    assert.match(String(outcome.error), /9\.999999/);
    assert.match(String(outcome.error), /parent/);
  });
});
