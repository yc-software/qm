import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { createPiTools, type ToolContextRef } from "../src/harness/pi-tools.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-readtools-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1", displayName: "Ada" };
const mate = { externalId: "U2", displayName: "Bob", type: "internal" as const };

function mention(text: string, channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor, mate] },
    deliveryTarget: `slack:${channel}:${root}`,
    text,
    liveActor: true,
    async: true,
  };
}

function startFulfiller(app: any, messages: unknown[]) {
  let running = true;
  const loop = (async () => {
    while (running) {
      const pending = await app.pendingContextRequests("slack");
      for (const r of pending) await app.fulfillContextRequest(r.id, { result: { messages } });
      await sleep(20);
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}

async function subToolResult(built: any, root: string, tool: string, deadlineMs = 6_000): Promise<any> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const sub = await built.sessions.getByThread(`ch:${root}`);
    if (sub) {
      const entries = await built.sessions.getEntries(sub.id);
      const hit = entries.find((e: any) => e.type === "assistant" && typeof e.payload?.text === "string");
      if (hit) return hit.payload.text as string;
    }
    await sleep(50);
  }
  throw new Error(`no assistant reply for ${tool}`);
}

test("whats_new returns POINTERS (counts of new-here + other active threads), never message prose", async () => {
  const built = freshApp();
  built.runtime.start();
  const root = "C10:1000.1";
  const stop = startFulfiller(built.app, [
    { ts: "1000.1", author: "Ann", text: "the anchor message" },
    { ts: "1000.2", author: "Bob", text: "here 1", threadTs: "1000.1" },
    { ts: "1000.3", author: "Cat", text: "here 2", threadTs: "1000.1" },
    { ts: "2000.2", author: "Dee", text: "other 1", threadTs: "2000.1" },
    { ts: "2000.3", author: "Eve", text: "other 2", threadTs: "2000.1" },
    { ts: "3000.1", author: "Fay", text: "a top-level channel post" },
  ]);
  try {
    await built.app.turn(mention("!whats_new", "C10", "1000.1"));
    const reply = await subToolResult(built, root, "whats_new");
    assert.match(reply, /whats_new here=3 others=1/);
  } finally {
    await stop();
    await built.runtime.stop();
  }
});

test("search falls back to a live scan when no cache is wired, returning author+snippet pointers", async () => {
  const built = freshApp();
  built.runtime.start();
  const root = "C11:1100.1";
  const stop = startFulfiller(built.app, [
    { ts: "1100.2", author: "Bob", text: "the budget doc is in shared/q2.md" },
    { ts: "1100.3", author: "Cat", text: "unrelated chatter" },
  ]);
  try {
    await built.app.turn(mention("!search budget", "C11", "1100.1"));
    const reply = await subToolResult(built, root, "search");
    assert.match(reply, /search\(live\) 1 hit/);
    assert.match(reply, /first=Bob:the budget doc/);
  } finally {
    await stop();
    await built.runtime.stop();
  }
});

test("read_members lists the current container's roster (its resolved audience), by display name", async () => {
  const built = freshApp();
  built.runtime.start();
  const root = "C12:1200.1";
  try {
    await built.app.turn(mention("!read_members", "C12", "1200.1"));
    const reply = await subToolResult(built, root, "read_members");
    assert.match(reply, /members: /);
    assert.match(reply, /Ada/);
    assert.match(reply, /Bob/);
  } finally {
    await built.runtime.stop();
  }
});

test("read_file returns text content for a text blob and a POINTER (never bytes) for a binary blob", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const textBlob = await built.blobTransfer.put(Buffer.from("hello from the shared file"));
    const binBlob = await built.blobTransfer.put(Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    const jpegLike = await built.blobTransfer.put(
      Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xdb, 0xc0, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5,
        0xf6, 0x87,
      ]),
    );

    await built.app.turn(mention(`!read_file ${textBlob.blobId}`, "C13", "1300.1"));
    const txt = await subToolResult(built, "C13:1300.1", "read_file");
    assert.match(txt, /file: hello from the shared file/);

    await built.app.turn(mention(`!read_file ${binBlob.blobId}`, "C14", "1400.1"));
    const bin = await subToolResult(built, "C14:1400.1", "read_file");
    assert.match(bin, /file-pointer:/);
    assert.doesNotMatch(bin, /hello from the shared file/);

    await built.app.turn(mention(`!read_file ${jpegLike.blobId}`, "C16", "1600.1"));
    const jpg = await subToolResult(built, "C16:1600.1", "read_file");
    assert.match(jpg, /file-pointer:/);

    await built.app.turn(mention("!read_file deadbeefdeadbeefdeadbeefdeadbeef", "C15", "1500.1"));
    const gone = await subToolResult(built, "C15:1500.1", "read_file");
    assert.match(gone, /couldn't read file/);
  } finally {
    await built.runtime.stop();
  }
});

function surfaceTool(tc: Record<string, unknown>): any {
  const ref = { current: tc } as unknown as ToolContextRef;
  return createPiTools(ref, { surfaceTools: true }).find((t) => t.name === "slack")!;
}

test("search action appends the mirror-coverage window to hits, and gives an honest no-match line when the mirror is bounded", async () => {
  const hit = await surfaceTool({
    async search() {
      return {
        ok: true,
        hits: [{ author: "Bob", when: "t", ref: "1.1", snippet: "the budget doc" }],
        source: "cache",
        coverageSince: "2026-06-01T00:00:00.000Z",
      };
    },
  }).execute("c1", { action: "search", query: "budget" });
  assert.match(hit.content[0].text, /the budget doc/);
  assert.match(hit.content[0].text, /mirror covers this channel since 2026-06-01/);

  const bounded = await surfaceTool({
    async search() {
      return { ok: true, hits: [], source: "cache", coverageSince: "2026-06-01T00:00:00.000Z" };
    },
  }).execute("c2", { action: "search", query: "budget" });
  assert.match(bounded.content[0].text, /no matches in the mirror — it only covers this channel since 2026-06-01/);
  assert.match(bounded.content[0].text, /retry with source "slack"/);

  const plain = await surfaceTool({
    async search() {
      return { ok: true, hits: [], source: "cache" };
    },
  }).execute("c3", { action: "search", query: "budget" });
  assert.match(plain.content[0].text, /nothing here matches "budget"/);

  const live = await surfaceTool({
    async search() {
      return { ok: true, hits: [], source: "slack" };
    },
  }).execute("c4", { action: "search", query: "budget" });
  assert.match(live.content[0].text, /as far as the asking person can see/);
});

test("search action forwards the `source` param to the tool context (§4.3)", async () => {
  let seen: string | undefined;
  await surfaceTool({
    async search(_q: string, opts?: { source?: string }) {
      seen = opts?.source;
      return { ok: true, hits: [], source: "live" };
    },
  }).execute("c1", { action: "search", query: "x", source: "slack" });
  assert.equal(seen, "slack");
});

test("whats_new action appends the mirror-coverage window when known", async () => {
  const r = await surfaceTool({
    async whatsNew() {
      return {
        ok: true,
        hereNew: 2,
        activeSubConversations: 1,
        latest: "5.0",
        coverageSince: "2026-06-01T00:00:00.000Z",
      };
    },
  }).execute("c1", { action: "whats_new" });
  assert.match(r.content[0].text, /mirror covers this channel since 2026-06-01/);
});

test("search/whats_new surface the mirror coverage window end-to-end once the mirror has ingested history (§4.1/§4.2)", async () => {
  const built = freshApp();
  built.runtime.start();
  const root = "C30:3000.1";
  await built.app.ingestSurfaceEvents(
    [
      {
        container: "slack:C30:3000.1",
        ts: "3000.1",
        authorId: "U2",
        authorName: "Bob",
        text: "an old budget note",
        createdAt: 1,
      },
    ],
    "slack",
  );
  const stop = startFulfiller(built.app, [{ ts: "3000.1", author: "Bob", text: "the budget doc" }]);
  try {
    await built.app.turn(mention("!search budget", "C30", "3000.1"));
    const searchReply = await subToolResult(built, root, "search");
    assert.match(searchReply, /coverage=\d{4}-\d\d-\d\d/, "the search reply carries the mirror coverage floor");
    await built.app.turn(mention("!whats_new", "C30", "3000.1"));
    const wnReply = await subToolResult(built, root, "whats_new");
    assert.match(wnReply, /coverage=\d{4}-\d\d-\d\d/, "whats_new carries the mirror coverage floor");
  } finally {
    await stop();
    await built.runtime.stop();
  }
});

test("search source=slack routes through the live-search seam; an unconfigured plugin surfaces the not-configured line (§4.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  const root = "C31:3100.1";
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const r of await built.app.pendingContextRequests("slack")) {
        const body = (r as any).query?.searchAll
          ? { messages: [], note: "live-search-unconfigured" }
          : { messages: [] };
        await built.app.fulfillContextRequest(r.id, { result: body });
      }
      await sleep(20);
    }
  })();
  try {
    await built.app.turn(mention("!search source=slack budget", "C31", "3100.1"));
    const reply = await subToolResult(built, root, "search");
    assert.match(reply, /live search isn't configured/);
  } finally {
    running = false;
    await loop;
    await built.runtime.stop();
  }
});

test("search source=slack with no connected login for the asker tells the agent to offer a connect link (§4.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  const root = "C32:3200.1";
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const r of await built.app.pendingContextRequests("slack")) {
        const q = (r as any).query ?? {};
        const body =
          q.searchAll && !q.viewerToken ? { messages: [], note: "live-search-unconnected" } : { messages: [] };
        await built.app.fulfillContextRequest(r.id, { result: body });
      }
      await sleep(20);
    }
  })();
  try {
    await built.app.turn(mention("!search source=slack budget", "C32", "3200.1"));
    const reply = await subToolResult(built, root, "search");
    assert.match(reply, /no connected one/, "the miss explains the missing login");
    assert.match(reply, /self-connect|Connectors page/, "and points at the session-gated self-connect page");
  } finally {
    running = false;
    await loop;
    await built.runtime.stop();
  }
});

test("set_standing_order writes the channel policy the ambient judge reads (recorded via a real turn)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.turn(
      mention("!set_standing_order when someone posts a tweet link, reply with a piratey line", "C20", "2000.1"),
    );
    const reply = await subToolResult(built, "C20:2000.1", "set_standing_order");
    assert.match(reply, /standing order set/);
    const policy = await built.app.getChannelPolicy("C20");
    assert.ok(policy && /piratey/.test(policy.orders), "the policy store holds what the tool wrote");

    await built.app.turn(mention("!get_standing_order", "C20", "2000.2"));
    const got = await subToolResult(built, "C20:2000.2", "get_standing_order");
    assert.match(got, /piratey/);
  } finally {
    await built.runtime.stop();
  }
});
