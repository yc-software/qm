import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { holdEmailDraft } from "../src/loops/email-draft.ts";
import { findInboxLoop } from "../src/loops/inbox-loop.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { ledgerState } from "../src/loops/ledger-view.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import type { ConnectorTokenSource } from "../src/loops/sources/adapter.ts";
import { buildGmailReplyMime, gmailAdapter, replySubject } from "../src/loops/sources/gmail.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { EntryType } from "../src/types.ts";

const DRAFT = { to: ["dana@northwind.io"], cc: ["priya@acme.co"], subject: "Q3 pricing", body: "Hi Dana,\n\nShort answer: no." };

test("holdEmailDraft files a held gmail compose item in the owner's inbox loop", async () => {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const held = await holdEmailDraft({ loops, items }, "sina@acme.co", DRAFT, "s1");
  const loop = await findInboxLoop(loops, "sina@acme.co");
  assert.ok(loop);
  assert.equal(held.loopId, loop.id);
  const item = await items.get(held.itemId);
  assert.ok(item);
  assert.equal(item.source, "gmail");
  assert.equal(ledgerState(item), "held");
  assert.equal(item.sourcePayload?.compose, true);
  assert.equal(item.sourcePayload?.title, "Q3 pricing");
  assert.equal(item.sourcePayload?.gmail, undefined);
  assert.deepEqual(item.proposal?.data, DRAFT);
  assert.equal(item.proposal?.by, "agent");
  assert.equal(item.proposal?.sessionId, "s1");

  const again = await holdEmailDraft({ loops, items }, "sina@acme.co", DRAFT);
  assert.notEqual(again.itemId, held.itemId, "every hand-off is its own item, never deduped");
  assert.equal(again.loopId, loop.id);
});

test("a compose item sends as a fresh message: no Re:, no thread, human edits win", async () => {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const held = await holdEmailDraft({ loops, items }, "sina@acme.co", DRAFT);
  const item = (await items.get(held.itemId))!;
  assert.equal(replySubject(item, { body: "x" }), "Q3 pricing");
  assert.match(buildGmailReplyMime(item, { body: "x", to: ["a@b.co"] }) ?? "", /^To: a@b\.co\r\nSubject: Q3 pricing\r\n/);
  assert.doesNotMatch(buildGmailReplyMime(item, { body: "x", to: ["a@b.co"] }) ?? "", /In-Reply-To/);

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const tokens: ConnectorTokenSource = { connectorAccessToken: async () => "tok" };
  const result = await gmailAdapter.act({ owner: "sina@acme.co", tokens, fetchImpl }, item, "send", {
    ...DRAFT,
    subject: "Q3 pricing (updated)",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.threadId, undefined);
  const mime = Buffer.from(String(calls[0]!.body.raw), "base64url").toString("utf8");
  assert.match(mime, /^To: dana@northwind\.io\r\nCc: priya@acme\.co\r\nSubject: Q3 pricing \(updated\)\r\n/);
});

type Emitted = { type: EntryType; payload: Record<string, unknown>; scopeLabel: string };

function toolsWith(tc: Partial<ToolContext>, emailDrafts = true) {
  const emitted: Emitted[] = [];
  const ref: ToolContextRef = {
    current: tc as ToolContext,
    emit: (e) => {
      emitted.push(e as Emitted);
    },
    scopeLabel: "personal:U1",
    pendingApprovals: [],
  };
  const tool = createAgentTools(ref, { emailDrafts }).find((t) => t.name === "send_email");
  const run = (params: unknown) =>
    (tool!.execute as unknown as (id: string, p: unknown) => Promise<{ content: Array<{ text?: string }> }>)("t", params);
  return { tool, run, emitted };
}

test("send_email hands the draft over and paints it for the UI, without sending anything", async () => {
  const seen: unknown[] = [];
  const { tool, run, emitted } = toolsWith({
    async holdEmailDraft(draft) {
      seen.push(draft);
      return { loopId: "l1", itemId: "i1" };
    },
  });
  assert.ok(tool);
  const result = await run({ to: [" dana@northwind.io "], subject: " Q3 pricing ", body: "Hi Dana\n" });
  assert.match(result.content[0]?.text ?? "", /handed to the user for review/);
  assert.deepEqual(seen, [{ to: ["dana@northwind.io"], subject: "Q3 pricing", body: "Hi Dana" }]);
  const persisted = emitted.find((e) => e.type === "tool_result")!.payload;
  assert.equal(persisted.tool, "send_email");
  assert.equal(persisted.isError, false);
  assert.deepEqual(persisted.display, {
    emailDraft: { loopId: "l1", itemId: "i1", to: ["dana@northwind.io"], subject: "Q3 pricing" },
  });
});

test("send_email rejects malformed input before it reaches the ledger", async () => {
  const { run, emitted } = toolsWith({
    async holdEmailDraft() {
      throw new Error("must not be called");
    },
  });
  const bad = await run({ to: ["not-an-address"], subject: "x", body: "y" });
  assert.match(bad.content[0]?.text ?? "", /not an email address/);
  const empty = await run({ to: [], subject: "x", body: "y" });
  assert.match(empty.content[0]?.text ?? "", /at least one recipient/);
  assert.ok(emitted.filter((e) => e.type === "tool_result").every((e) => e.payload.isError === true));
});

test("send_email is offered only when the turn can hold drafts, and explains itself otherwise", async () => {
  assert.equal(toolsWith({}, false).tool, undefined);
  const { run } = toolsWith({});
  const result = await run({ to: ["a@b.co"], subject: "x", body: "y" });
  assert.match(result.content[0]?.text ?? "", /Gmail is not connected/);
});
