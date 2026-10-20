import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { completedSurfaceEnqueues, turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";
import { storedItem, type NewItem } from "../src/sessions/items.ts";

function freshApp() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-dedup-")) }));
}

const actor = { externalId: "U1" };

function channelTurn(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: "ch:C9:t1", channelRef: "C9", audience: [actor] },
    deliveryTarget: "slack:C9:t1",
    surfaceTools: true,
    addressed: true,
    liveActor: true,
    text,
    ...extra,
  };
}

test("a retried turn does not re-post: the same position dedups against the delivered row", async () => {
  const built = freshApp();
  const req = channelTurn("!post-lost-result deploy is done", { idempotencyKey: "dedup-retry-1" });

  await assert.rejects(built.app.turn(req), /boom/);
  const afterFirst = await built.deliveries.pending("slack");
  assert.equal(afterFirst.length, 1, "the interrupted attempt already enqueued its post");

  const res = await built.app.turn(req);
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.deliveries.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.equal(rows.length, 1, "the retry's re-post collapses onto the first attempt's delivery");
  assert.equal(rows[0]!.text, "deploy is done", "the delivered copy is the first attempt's, keyed not text-matched");
  assert.match(
    rows[0]!.idempotencyKey,
    /^post:.+:slack:slack:C9:t1:0$/,
    "the key is the turn's run id, the destination, and the position — nothing per-attempt",
  );
});

test("a resumed turn's NEW post after a completed one is delivered, not swallowed by the dedup", async () => {
  const built = freshApp();
  const req = channelTurn("!post-then-boom first update|second update", { idempotencyKey: "dedup-resume-1" });

  await assert.rejects(built.app.turn(req), /boom/);
  const res = await built.app.turn(req);
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.deliveries.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.deepEqual(
    rows.map((d) => d.text).sort(),
    ["first update", "second update"],
    "the completed post is recorded work, so the resume's continuation posts at the next position",
  );
  assert.equal(new Set(rows.map((d) => d.idempotencyKey)).size, 2, "each post holds its own key");
});

test("a retried automation fire (surface 'monitor') still seeds past its recorded post — the NEW post delivers", async () => {
  const built = freshApp();
  const req: TurnRequest = {
    surface: "monitor",
    actor,
    conversation: { kind: "channel", threadRef: "monitor:M1:t1", channelRef: "C9", audience: [actor] },
    surfaceTools: true,
    triggered: true,
    triggerDestination: { type: "slack", target: "slack:C9:t1" },
    text: "!post-then-boom monitor first|monitor second",
    idempotencyKey: "dedup-monitor-1",
  };

  await assert.rejects(built.app.turn(req), /boom/);
  const res = await built.app.turn(req);
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.deliveries.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.deepEqual(
    rows.map((d) => d.text).sort(),
    ["monitor first", "monitor second"],
    "the seed counts entries recorded under the surface tool's real name, not the fire's surface label",
  );
});

test("distinct posts in one turn each get their own key and all deliver", async () => {
  const built = freshApp();
  const res = await built.app.turn(channelTurn("!post2 alpha|beta", { idempotencyKey: "dedup-two-1" }));
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.deliveries.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.deepEqual(rows.map((d) => d.text).sort(), ["alpha", "beta"]);
  assert.equal(new Set(rows.map((d) => d.idempotencyKey)).size, 2);
});

test("completedSurfaceEnqueues counts only completed surface enqueue calls after the interrupted user entry", () => {
  const entry = (seq: number, item: NewItem) => storedItem(item, { sessionId: "s", seq, createdAt: seq });
  const entries = [
    entry(0, { kind: "UserMessage", text: "!go" }),
    entry(1, { kind: "ToolCall", tool: "slack", callId: "a", body: { action: "post" } }),
    entry(2, { kind: "ToolResult", tool: "slack", callId: "a", body: { action: "post", ok: true } }),
    entry(3, { kind: "ToolCall", tool: "execute", callId: "b", body: { command: "make" } }),
    entry(4, { kind: "ToolResult", tool: "execute", callId: "b", body: { ok: true } }),
    entry(5, { kind: "ToolCall", tool: "slack", callId: "c", body: { action: "reach" } }),
    entry(6, { kind: "ToolResult", tool: "slack", callId: "c", body: { action: "reach", ok: true } }),
    entry(7, { kind: "ToolCall", tool: "slack", callId: "d", body: { action: "post" } }),
    entry(8, { kind: "ToolResult", tool: "slack", callId: "d", isError: true, body: { interrupted: true } }),
  ];
  assert.equal(completedSurfaceEnqueues(entries, 0, "slack"), 2, "the interrupted post at seq 7 is not counted");
  assert.equal(completedSurfaceEnqueues(entries, 5, "slack"), 0, "entries at or before sinceSeq are excluded");
});

test("turnPostKeys mints deterministic per-destination position keys and seeds past recorded work", () => {
  const keys = turnPostKeys("run-1");
  const dest = { type: "slack", target: "C1:100.1" };
  assert.equal(keys.key(dest, keys.take()), "post:run-1:slack:C1:100.1:0");
  assert.equal(keys.key(dest, keys.take()), "post:run-1:slack:C1:100.1:1");
  const seeded = turnPostKeys("run-1");
  seeded.seed(2);
  assert.equal(seeded.key(dest, seeded.take()), "post:run-1:slack:C1:100.1:2");
});
