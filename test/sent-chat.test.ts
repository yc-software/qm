import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSentChat, loopItemRoutes } from "../src/api/routes/loop-items.ts";
import { findRoute, run, type ApiCtx } from "../src/api/routes/route.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";

test("sent chats are durable, idempotent, and isolated to the signed-in owner", async () => {
  const store = createLoopStore();
  const items = createLoopItemLedger();
  let status = 0;
  let response: { item: { id: string; loopId: string; state: string; thread: { text: string }[] } };
  const ctx = {
    actor: { p: "alice" },
    url: new URL("http://localhost/?principalId=bob"),
    body: { threadId: "sent-only-thread", subject: "No inbox match", from: "Alice", text: "The sent email body" },
    deps: { loops: { store, items } },
    res: {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(data: string) {
        response = JSON.parse(data);
      },
    },
  } as unknown as ApiCtx;
  await ensureSentChat(ctx);
  assert.equal(status, 200);
  const original = response!.item;
  assert.equal(original.state, "held");
  assert.equal((await store.get(original.loopId))!.owner, "alice");
  assert.equal((await items.get(original.id))!.sourcePayload!.snippet, "The sent email body");
  await items.appendThread(original.id, [{ role: "human", text: "Summarize this" }]);
  await ensureSentChat(ctx);
  assert.equal(response!.item.id, original.id);
  assert.equal(response!.item.thread[0]!.text, "Summarize this");
  ctx.actor = { p: "bob" } as ApiCtx["actor"];
  await ensureSentChat(ctx);
  assert.notEqual(response!.item.id, original.id);
  assert.equal(response!.item.thread.length, 0);
  ctx.actor = undefined;
  await ensureSentChat(ctx);
  assert.equal(status, 403);
});

test("a sent email draft saves and sends into the original Gmail thread exactly once", async () => {
  const store = createLoopStore();
  const items = createLoopItemLedger();
  let response: { item: { id: string; loopId: string; proposal?: { at: number; data: { body: string } } } };
  let status = 0;
  const ctx = {
    actor: { p: "alice" },
    url: new URL("http://localhost/"),
    body: {
      threadId: "thread-1",
      subject: "Project update",
      from: "Alice",
      to: "Bob <bob@example.com>",
      cc: "Casey <casey@example.com>",
      rfcMessageId: "<original@example.com>",
      text: "Original sent message",
    },
    deps: { loops: { store, items }, loopSourceTokens: { connectorAccessToken: async () => "test-token" } },
    app: {
      membershipControlsScope: async () => false,
      samePerson: async (a: string, b: string) => a === b,
      managesScope: async () => false,
    },
    res: {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(data: string) {
        response = JSON.parse(data);
      },
    },
  } as unknown as ApiCtx;
  await ensureSentChat(ctx);
  const { id, loopId } = response!.item;
  const found = findRoute(loopItemRoutes, "POST", `/v1/loops/${loopId}/items/${id}/action`)!;
  const action = async (kind: string, args = {}) => {
    ctx.body = { kind, args };
    await run(found.route, found.params, ctx);
  };
  const draft = {
    to: ["Bob <bob@example.com>"],
    cc: ["Casey <casey@example.com>"],
    subject: "Project update",
    body: "Following up",
  };
  await action("edit", { proposal: draft });
  assert.equal(status, 200);
  assert.equal(response!.item.proposal!.data.body, "Following up");
  const savedAt = response!.item.proposal!.at;
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (_url, init) => {
    sent++;
    const message = JSON.parse(String(init!.body));
    assert.equal(message.threadId, "thread-1");
    const mime = Buffer.from(message.raw, "base64url").toString();
    assert.match(mime, /To: Bob <bob@example.com>/);
    assert.match(mime, /Cc: Casey <casey@example.com>/);
    assert.match(mime, /In-Reply-To: <original@example.com>/);
    return Response.json({ id: "sent-reply", threadId: "thread-1" });
  };
  try {
    await action("send", { proposal: draft, expectedProposalAt: savedAt });
    assert.equal(status, 200);
    await action("send", { proposal: draft, expectedProposalAt: savedAt });
    assert.equal(status, 409);
    assert.equal(sent, 1);
    await action("reply");
    assert.equal(status, 200);
    assert.equal(response!.item.proposal!.data.body, "");
    await action("send", { proposal: draft, expectedProposalAt: savedAt });
    assert.equal(status, 409);
    assert.equal(sent, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
