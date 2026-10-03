import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitContextOutcome, createSurfaceContextPuller } from "../src/api/surface-context-puller.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../src/types.ts";

function fakeApp(behavior: (id: string) => { status: string; result?: SurfaceContextResult }) {
  let lastId = 0;
  const deleted: string[] = [];
  const created: Array<{ source: string; query: SurfaceContextQuery }> = [];
  const settled = createMemoryEventBus<string>("test");
  const reads: string[] = [];
  return {
    deleted,
    created,
    settled,
    reads,
    onContextRequestSettled(listener: (id: string) => void, onResync: () => void) {
      return settled.subscribe(listener, { onResync });
    },
    async createContextRequest(source: string, query: SurfaceContextQuery) {
      created.push({ source, query });
      return { id: `req-${++lastId}` };
    },
    async getContextRequest(id: string) {
      reads.push(id);
      return behavior(id);
    },
    async deleteContextRequest(id: string) {
      deleted.push(id);
    },
  };
}

test("surface-context puller returns the fulfilled messages and cleans up the request", async () => {
  const app = fakeApp(() => ({ status: "done", result: { messages: [{ ts: "1", text: "hi" }] } }));
  const puller = createSurfaceContextPuller(app, { waitMs: 200 });
  const out = await puller.pull("slack", { conversationTarget: "slack:C1:1.1", count: 50 });
  assert.deepEqual(out, { messages: [{ ts: "1", text: "hi" }] });
  assert.equal(app.created[0]!.query.conversationTarget, "slack:C1:1.1");
  assert.equal(app.created[0]!.source, "slack", "the request is routed to the turn's own surface, not a hardcoded one");
  assert.equal(app.deleted.length, 1, "the request row is cleaned up");
});

test("surface-context puller returns null on a surface failure, and cleans up", async () => {
  const app = fakeApp(() => ({ status: "failed" }));
  const puller = createSurfaceContextPuller(app, { waitMs: 200 });
  const out = await puller.pull("slack", { conversationTarget: "slack:C1:1.1", count: 50 });
  assert.equal(out, null);
  assert.equal(app.deleted.length, 1);
});

test("searchLive resolves the viewer's own search token and rides it on the query", async () => {
  const app = fakeApp(() => ({ status: "done", result: { messages: [] } }));
  const puller = createSurfaceContextPuller(app, {
    waitMs: 200,
    searchToken: async (source, viewer) => (source === "slack" && viewer === "diana" ? "xoxp-diana" : null),
  });
  await puller.searchLive!("slack", {
    conversationTarget: "slack:C1:1.1",
    count: 50,
    viewer: "diana",
    searchAll: "hubble",
  });
  assert.equal(app.created[0]!.query.viewerToken, "xoxp-diana", "the asker's connected token is attached");
  await puller.searchLive!("slack", {
    conversationTarget: "slack:C1:1.1",
    count: 50,
    viewer: "bob",
    searchAll: "hubble",
  });
  assert.equal(app.created[1]!.query.viewerToken, undefined, "no connected login → no token on the query");
});

test("surface-context puller times out (returns null) when the surface never answers", async () => {
  const app = fakeApp(() => ({ status: "pending" }));
  const puller = createSurfaceContextPuller(app, { waitMs: 30 });
  const out = await puller.pull("slack", { conversationTarget: "slack:C1:1.1", count: 50 });
  assert.equal(out, null);
  assert.equal(app.deleted.length, 1, "a timed-out request is still cleaned up");
});

test("a request already answered resolves on the first read without waiting", async () => {
  const app = fakeApp(() => ({ status: "done", result: { messages: [] } }));
  const started = Date.now();
  await awaitContextOutcome(app, "req-1", { waitMs: 10_000, recheckMs: 10_000 });
  assert.ok(Date.now() - started < 50);
  assert.equal(app.reads.length, 1);
  assert.equal(app.settled.size(), 0);
});

test("a settled notification wakes the waiter, other ids and resync re-read, and it unsubscribes", async () => {
  let status = "pending";
  const app = fakeApp(() => ({ status, result: { messages: [] } }));
  const outcome = awaitContextOutcome(app, "req-1", { waitMs: 10_000, recheckMs: 10_000 });
  await new Promise((r) => setImmediate(r));
  app.settled.emit("req-2");
  app.settled.resync();
  await new Promise((r) => setImmediate(r));
  status = "done";
  app.settled.emit("req-1");
  assert.equal((await outcome).status, "done");
  assert.equal(app.reads.length, 3);
  assert.equal(app.settled.size(), 0);
});

test("a missed notification is recovered by the bounded recheck, and abort ends the wait early", async () => {
  let status = "pending";
  const app = fakeApp(() => ({ status, result: { messages: [] } }));
  const recovered = awaitContextOutcome(app, "req-1", { waitMs: 10_000, recheckMs: 20 });
  status = "done";
  assert.equal((await recovered).status, "done");
  status = "pending";
  const controller = new AbortController();
  const aborted = awaitContextOutcome(app, "req-2", { waitMs: 10_000, signal: controller.signal });
  await new Promise((r) => setImmediate(r));
  const readsBeforeAbort = app.reads.length;
  controller.abort();
  assert.equal((await aborted).status, "timeout");
  assert.equal(app.reads.length, readsBeforeAbort);
  const midRead = new AbortController();
  const startedMidRead = Date.now();
  const abortedMidRead = awaitContextOutcome(
    { ...app, getContextRequest: async () => (midRead.abort(), { status: "pending" }) },
    "req-3",
    { waitMs: 10_000, recheckMs: 10_000, signal: midRead.signal },
  );
  assert.equal((await abortedMidRead).status, "timeout");
  assert.ok(Date.now() - startedMidRead < 1_000);
  assert.equal(app.settled.size(), 0);
  assert.deepEqual(app.deleted, ["req-1", "req-2", "req-3"]);
});
