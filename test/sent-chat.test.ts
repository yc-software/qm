import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSentChat, loopItemRoutes } from "../src/api/routes/loop-items.ts";
import { buildGmailReplyMime } from "../src/loops/sources/gmail.ts";
import { findRoute, run, type ApiCtx } from "../src/api/routes/route.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";

test("sent chats are durable, idempotent, and isolated to the signed-in owner", async () => {
  const store = createLoopStore();
  const items = createLoopItemLedger();
  let previewEnabled = false;
  let status = 0;
  let response: { item: { id: string; loopId: string; state: string; thread: { text: string }[] } };
  const ctx = {
    actor: { p: "alice" },
    url: new URL("http://localhost/?principalId=bob"),
    body: { threadId: "sent-only-thread", subject: "No inbox match", from: "Alice", text: "The sent email body" },
    deps: { loops: { store, items }, featureFlags: { enabled: async () => previewEnabled } },
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
  assert.equal(status, 403);
  assert.equal((await store.list()).length, 0);
  previewEnabled = true;
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
  await items.setProposal(original.id, { data: { body: "My unfinished draft" }, by: "human" });
  const proposal = (await items.get(original.id))!.proposal;
  ctx.body = {
    threadId: "sent-only-thread",
    messageId: "newer-message",
    subject: "New title",
    from: "New sender",
    text: "New context",
  };
  await ensureSentChat(ctx);
  const refreshed = (await items.get(original.id))!;
  assert.deepEqual(refreshed.proposal, proposal);
  assert.equal(refreshed.sourcePayload!.snippet, "New context");
  assert.equal(refreshed.sourcePayload!.from, "New sender");
  assert.equal(refreshed.sourcePayload!.title, "New title");
  assert.equal(refreshed.sourceSummary, "New title");
  assert.equal((refreshed.sourcePayload!.gmail as { messageId: string }).messageId, "newer-message");
  ctx.body = { ...(ctx.body as object), accountType: "personal" };
  await ensureSentChat(ctx);
  assert.notEqual(response!.item.id, original.id);
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
    deps: {
      loops: { store, items },
      loopSourceTokens: { connectorAccessToken: async () => "test-token" },
      featureFlags: { enabled: async () => true },
    },
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

test("sent chat preserves long quoted recipient headers and rejects oversized input", async () => {
  const store = createLoopStore();
  const items = createLoopItemLedger();
  let status = 0;
  let id = "";
  const to = [
    '"Doe, Jane" <jane@example.com>',
    ...Array.from({ length: 15 }, (_, i) => `Recipient ${i} <recipient${i}@example.com>`),
  ].join(", ");
  const cc = '"Smith, Casey" <casey@example.com>';
  const ctx = {
    actor: { p: "alice" },
    body: { threadId: "t", to, cc },
    deps: { loops: { store, items }, featureFlags: { enabled: async () => true } },
    res: {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(data: string) {
        id = JSON.parse(data).item?.id ?? "";
      },
    },
  } as unknown as ApiCtx;
  await ensureSentChat(ctx);
  assert.equal(status, 200);
  const stored = (await items.get(id))!;
  const mime = buildGmailReplyMime(stored, { body: "Hello" })!;
  assert.ok(mime.startsWith(`To: ${to}\r\nCc: ${cc}\r\n`));
  for (const invalid of [
    { to: "x".repeat(8001) },
    { cc: "x".repeat(8001) },
    { to: "a@example.com\r\nBcc: b@example.com" },
    { accountType: "forged" },
    { accountType: ["default"] },
  ]) {
    ctx.body = { threadId: "t", ...invalid };
    await ensureSentChat(ctx);
    assert.equal(status, 400);
    assert.deepEqual((await items.get(stored.id))!.sourcePayload, stored.sourcePayload);
  }
});
