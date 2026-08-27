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
  const replyCalls: string[] = [];
  const client = {
    conversations: {
      history: async () => ({ messages: HISTORY }),
      replies: async ({ ts }: { ts: string }) => {
        replyCalls.push(ts);
        return { messages: THREADS[ts] ?? [] };
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
    return ((fulfilled[0] as { result: { messages: Array<{ ts: string; text: string; threadTs?: string }> } }).result ??
      {}) as { messages: Array<{ ts: string; text: string; threadTs?: string }> };
  };
  return { pull, replyCalls };
}

describe("surface-context channel reads", () => {
  it("expands recent threads when reading a channel top-level, not just parents", async () => {
    const { pull, replyCalls } = harness();
    const result = await pull({ conversationTarget: "C1", count: 50 });
    assert.deepEqual(replyCalls, ["1.000000"], "each recent thread parent is expanded once");
    assert.deepEqual(
      result.messages.map((m) => m.ts),
      ["1.000000", "2.000000", "3.000000", "4.000000"],
      "thread replies ride along with the top-level history, in order",
    );
    assert.equal(result.messages[1]!.threadTs, "1.000000", "a reply carries its parent's ts");
  });

  it("pulls one full thread when the query names a threadTs", async () => {
    const { pull, replyCalls } = harness();
    const result = await pull({ conversationTarget: "C1", threadTs: "1.000000", count: 50 });
    assert.ok(replyCalls.includes("1.000000"), "the named thread is fetched directly");
    assert.ok(
      result.messages.some((m) => m.text === "second reply"),
      "the thread's replies are in the window",
    );
  });
});
