import { test } from "node:test";
import assert from "node:assert/strict";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/surfaces/surface-tools.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { testSurfaces } from "./support/single-process.ts";
import type { SandboxHandle } from "../src/sandbox/sandbox.ts";

const handle = { rootDir: "/root/workspace" } as SandboxHandle;

type Enqueued = { destination: Record<string, unknown>; text: string; idempotencyKey: string };

function toolsWithDeliveries(opts: {
  settle?: (id: string, poll: number) => Record<string, unknown> | null;
  audience?: Array<{ id: string }>;
  directory?: {
    getMany?: (ids: readonly string[]) => Promise<Map<string, { principalId: string; slackId?: string }>>;
  };
  enqueued?: Enqueued[];
}) {
  const enqueued = opts.enqueued ?? [];
  const polls = new Map<string, number>();
  const store = createDeliveryStore();
  return {
    tools: createSurfaceToolDeps({
      deps: {
        surfaces: testSurfaces(),
        deliveries: {
          async enqueue(input: Enqueued) {
            enqueued.push(input);
            return { id: `d${enqueued.length}`, ...input } as never;
          },
          async get(id: string) {
            const settle = opts.settle;
            if (!settle) return store.get(id);
            const poll = (polls.get(id) ?? 0) + 1;
            polls.set(id, poll);
            return settle(id, poll) as never;
          },
        },
        directory: {
          async getMany(ids: readonly string[]) {
            return (
              opts.directory?.getMany?.(ids) ??
              Promise.resolve(new Map(ids.map((id) => [id, { principalId: id, slackId: id }])))
            );
          },
        } as never,
      },
      input: { surfaceTools: true, surface: "slack", liveReplies: true },
      actor: { id: "U0", type: "internal" },
      conversation: {
        kind: "channel",
        channelRef: "C1",
        audience: (opts.audience ?? [{ id: "U2" }, { id: "U0" }]).map((p) => ({ ...p, type: "internal" })),
      },
      session: { id: "S1" },
      scopeId: "channel:C1",
      defaultDestination: { type: "slack", target: "C1:100.200" },
      strictReadOnly: false,
      blobTransfer: {},
      fileRegistration: {},
      provision: async () => handle,
      postProvenance() {
        return {} as never;
      },
      postKeys: turnPostKeys("run-settle"),
      spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
    } as unknown as SurfaceToolsContext)!,
    enqueued,
  };
}

test("post waits for the delivery to settle and reports the message ts", async () => {
  const settled = { id: "d1", deliveredAt: Date.now(), messageTs: "1795030226.902129" };
  const { tools } = toolsWithDeliveries({
    settle: (id, poll) => (poll < 2 ? { id, deliveredAt: null } : settled),
  });
  const r = await tools.post("hello", undefined);
  assert.equal(r.ok, true);
  assert.equal(r.ts, "1795030226.902129", "the tool result names the message it just posted");
});

test("post still succeeds without a ts when the delivery doesn't settle in time", async () => {
  const { tools } = toolsWithDeliveries({ settle: (id) => ({ id, deliveredAt: null }) });
  const r = await tools.post("hello", undefined);
  assert.equal(r.ok, true);
  assert.equal(r.ts, undefined);
});

test("an edit the surface refuses reports the ref wasn't one of the bot's own messages", async () => {
  const { tools } = toolsWithDeliveries({
    settle: (id) => ({ id, deliveredAt: null, failedReason: "cant_update_message" }),
  });
  const r = await tools.edit({ ref: "123.456", text: "revised" });
  assert.equal(r.ok, false, "a terminal edit failure is not reported as success");
  assert.match(r.message ?? "", /123\.456 isn't one of my own messages/);
  assert.match(r.message ?? "", /cant_update_message/);
});

test("a post that fails terminally reports the delivery failure", async () => {
  const { tools } = toolsWithDeliveries({
    settle: (id) => ({ id, deliveredAt: null, failedReason: "channel_not_found" }),
  });
  const r = await tools.post("hello", undefined);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /channel_not_found/);
});

test("mentions of people outside the conversation are sent as plain text and flagged", async () => {
  const { tools, enqueued } = toolsWithDeliveries({
    settle: (id) => ({ id, deliveredAt: Date.now(), messageTs: "1.1" }),
    audience: [{ id: "U2" }],
    directory: {
      getMany: async () => new Map([["U2", { principalId: "U2", slackId: "U2" }]]),
    },
  });
  const r = await tools.post("ping <@U2> and <@U999>", undefined);
  assert.equal(r.ok, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.text, "ping <@U2> and @U999", "the roster member stays a mention, the stranger doesn't");
  assert.match(r.notes?.[0] ?? "", /@U999/);
  assert.match(r.notes?.[0] ?? "", /nobody was pinged/);
});

test("mentions are left untouched when the roster can't be read", async () => {
  const { tools, enqueued } = toolsWithDeliveries({
    settle: (id) => ({ id, deliveredAt: Date.now(), messageTs: "1.1" }),
    directory: {
      getMany: async () => {
        throw new Error("directory down");
      },
    },
  });
  const r = await tools.post("ping <@U999>", undefined);
  assert.equal(r.ok, true);
  assert.equal(enqueued[0]!.text, "ping <@U999>", "an unreadable roster never rewrites the message");
  assert.equal(r.notes, undefined);
});
