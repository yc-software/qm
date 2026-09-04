import { test } from "node:test";
import assert from "node:assert/strict";
import { createSurfaceContextPuller } from "../src/api/surface-context-puller.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../src/types.ts";

function fakeApp(behavior: (id: string) => { status: string; result?: SurfaceContextResult }) {
  let lastId = 0;
  const deleted: string[] = [];
  const created: Array<{ source: string; query: SurfaceContextQuery }> = [];
  return {
    deleted,
    created,
    async createContextRequest(source: string, query: SurfaceContextQuery) {
      created.push({ source, query });
      return { id: `req-${++lastId}` };
    },
    async getContextRequest(id: string) {
      return behavior(id);
    },
    async deleteContextRequest(id: string) {
      deleted.push(id);
    },
  };
}

test("surface-context puller returns the fulfilled messages and cleans up the request", async () => {
  const app = fakeApp(() => ({ status: "done", result: { messages: [{ ts: "1", text: "hi" }] } }));
  const puller = createSurfaceContextPuller(app, { pollMs: 1, waitMs: 200 });
  const out = await puller.pull("slack", { conversationTarget: "slack:C1:1.1", count: 50 });
  assert.deepEqual(out, { messages: [{ ts: "1", text: "hi" }] });
  assert.equal(app.created[0]!.query.conversationTarget, "slack:C1:1.1");
  assert.equal(app.created[0]!.source, "slack", "the request is routed to the turn's own surface, not a hardcoded one");
  assert.equal(app.deleted.length, 1, "the request row is cleaned up");
});

test("surface-context puller returns null on a surface failure, and cleans up", async () => {
  const app = fakeApp(() => ({ status: "failed" }));
  const puller = createSurfaceContextPuller(app, { pollMs: 1, waitMs: 200 });
  const out = await puller.pull("slack", { conversationTarget: "slack:C1:1.1", count: 50 });
  assert.equal(out, null);
  assert.equal(app.deleted.length, 1);
});

test("searchLive resolves the viewer's own search token and rides it on the query", async () => {
  const app = fakeApp(() => ({ status: "done", result: { messages: [] } }));
  const puller = createSurfaceContextPuller(app, {
    pollMs: 1,
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
  const puller = createSurfaceContextPuller(app, { pollMs: 5, waitMs: 30 });
  const out = await puller.pull("slack", { conversationTarget: "slack:C1:1.1", count: 50 });
  assert.equal(out, null);
  assert.equal(app.deleted.length, 1, "a timed-out request is still cleaned up");
});
