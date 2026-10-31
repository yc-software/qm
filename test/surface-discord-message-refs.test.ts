import { test } from "node:test";
import assert from "node:assert/strict";
import { createSurfaceToolDeps } from "../src/surfaces/surface-tools.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";

const ID = "1000000000000000005";
const TOKEN = "~7lieexzx4kxx";

function tools(surface: "discord" | "slack") {
  const enqueued: Array<{ destination: Record<string, any> }> = [];
  const t = createSurfaceToolDeps({
    deps: {
      deliveries: {
        enqueue: async (e: { destination: Record<string, any> }) => {
          enqueued.push(e);
          return { id: `d${enqueued.length}` };
        },
      },
    },
    input: { surface, surfaceTools: true, origin: { kind: "human" } },
    actor: { id: "reader@example.com" },
    conversation: { kind: "dm" },
    session: { id: "S1" },
    scopeId: "channel:C1",
    strictReadOnly: false,
    defaultDestination: { type: surface, target: "C1" },
    postProvenance: () => ({}),
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as any)!;
  return { t, enqueued };
}

test("a Discord react, edit, delete or reply with an unusable message id fails at the tool call and enqueues nothing", async () => {
  const { t, enqueued } = tools("discord");
  for (const bad of ["~zz", "17", "1700000000.000100", "garbage"]) {
    const results = [
      await t.react({ ts: bad, emoji: "eyes" }),
      await t.edit({ ref: bad, text: "x" }),
      await t.delete({ ref: bad }),
      await t.post("hi", { ts: bad }),
    ];
    for (const r of results) {
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : (r.message ?? ""), /not a message id from this conversation/);
    }
  }
  assert.deepEqual(enqueued, []);
});

test("a Discord ~token or raw snowflake is enqueued as the raw snowflake", async () => {
  const { t, enqueued } = tools("discord");
  for (const ref of [TOKEN, ID]) {
    assert.equal((await t.react({ ts: ref, emoji: "eyes" })).ok, true);
    assert.equal((await t.edit({ ref, text: "x" })).ok, true);
    assert.equal((await t.delete({ ref })).ok, true);
    assert.equal((await t.post("hi", { ts: ref })).ok, true);
  }
  const d = enqueued.map((e) => e.destination);
  assert.equal(d.length, 8);
  for (let i = 0; i < 8; i += 4) {
    assert.equal(d[i]!.react.messageTs, ID);
    assert.equal(d[i + 1]!.editRef, ID);
    assert.equal(d[i + 2]!.delete.messageTs, ID);
    assert.equal(d[i + 3]!.target, `C1:${ID}`);
  }
});

test("Slack refs are not validated against the Discord id shape", async () => {
  const { t, enqueued } = tools("slack");
  assert.equal((await t.react({ ts: "1700000000.000100", emoji: "eyes" })).ok, true);
  assert.equal(enqueued[0]!.destination.react.messageTs, "1700000000.000100");
});
