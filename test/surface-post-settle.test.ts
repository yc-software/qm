import { test } from "node:test";
import assert from "node:assert/strict";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/surfaces/surface-tools.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";
import { testSurfaces } from "./support/single-process.ts";
import type { SandboxHandle } from "../src/sandbox/sandbox.ts";

const handle = { rootDir: "/root/workspace" } as SandboxHandle;

function toolsWithDeliveries(opts: {
  settle?: (id: string, poll: number) => Record<string, unknown> | null;
  audience?: Array<{ id: string }>;
  directory?: (ids: readonly string[]) => Promise<Map<string, { principalId: string; slackId?: string }>>;
}) {
  const enqueued: Array<{ destination: Record<string, unknown>; text: string }> = [];
  const polls = new Map<string, number>();
  const settled = (id: string) => {
    const poll = (polls.get(id) ?? 0) + 1;
    polls.set(id, poll);
    return opts.settle?.(id, poll) ?? { id, deliveredAt: Date.now(), messageTs: "1.1" };
  };
  return {
    enqueued,
    tools: createSurfaceToolDeps({
      deps: {
        surfaces: testSurfaces(),
        deliveries: {
          async enqueue(input: { destination: Record<string, unknown>; text: string }) {
            enqueued.push(input);
            return { id: `d${enqueued.length}`, ...input } as never;
          },
          async get(id: string) {
            return settled(id) as never;
          },
        },
        directory: {
          getMany: (ids: readonly string[]) =>
            opts.directory?.(ids) ?? Promise.resolve(new Map(ids.map((id) => [id, { principalId: id, slackId: id }]))),
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
  };
}

test("post waits for the delivery to settle and reports the message ts", async () => {
  const { tools } = toolsWithDeliveries({
    settle: (id, poll) =>
      poll < 2 ? { id, deliveredAt: null } : { id, deliveredAt: 1, messageTs: "1795030226.902129" },
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

test("mentions of strangers go out as written and come back flagged with the ts", async () => {
  const { tools, enqueued } = toolsWithDeliveries({
    audience: [{ id: "U2" }],
    directory: async () => new Map([["U2", { principalId: "U2", slackId: "U2" }]]),
  });
  const r = await tools.post("ping <@U2> and <@U999> twice <@U999>", undefined);
  assert.equal(enqueued[0]!.text, "ping <@U2> and <@U999> twice <@U999>", "the text is never rewritten");
  assert.match(r.notes?.[0] ?? "", /unverified id may ping an unintended person; edit the message \(ts 1\.1\)/);
  assert.equal((r.notes?.[0] ?? "").match(/<@U999>/g)?.length, 1, "a stranger id is listed once, roster ids never");
});

test("mentions are left untouched when the roster can't be read", async () => {
  const { tools, enqueued } = toolsWithDeliveries({
    directory: async () => {
      throw new Error("directory down");
    },
  });
  const r = await tools.post("ping <@U999>", undefined);
  assert.equal(r.ok, true);
  assert.equal(enqueued[0]!.text, "ping <@U999>", "an unreadable roster neither rewrites nor flags the message");
  assert.equal(r.notes, undefined);
});
