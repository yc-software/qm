import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { holdEmailDraft } from "../src/loops/email-draft.ts";
import { findInboxLoop } from "../src/loops/inbox-loop.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { ledgerState } from "../src/loops/ledger-view.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import type { ConnectorTokenSource } from "../src/loops/sources/adapter.ts";
import { buildGmailReplyMime, gmailAdapter, MAX_ATTACHMENT_BYTES, replySubject } from "../src/loops/sources/gmail.ts";
import { Readable } from "node:stream";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { EntryType } from "../src/types.ts";

const DRAFT = {
  to: ["dana@northwind.io"],
  cc: ["priya@acme.co"],
  subject: "Q3 pricing",
  body: "Hi Dana,\n\nShort answer: no.",
};

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
  assert.match(
    buildGmailReplyMime(item, { body: "x", to: ["a@b.co"] }) ?? "",
    /^To: a@b\.co\r\nSubject: Q3 pricing\r\n/,
  );
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

test("attachments ride along as a multipart/mixed message built from stored artifacts", async () => {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const attachment = { artifactId: "art-1", name: 'q3 "pricing".csv', mimetype: "text/csv", sizeBytes: 12 };
  const held = await holdEmailDraft({ loops, items }, "sina@acme.co", { ...DRAFT, attachments: [attachment] });
  const item = (await items.get(held.itemId))!;
  assert.deepEqual((item.proposal!.data as { attachments: unknown }).attachments, [attachment]);

  const opened: string[] = [];
  const files = {
    open: async (id: string) => {
      opened.push(id);
      if (id !== "art-1") return null;
      return { artifact: {} as never, sizeBytes: 12, stream: Readable.from([Buffer.from("seat,price\n1,2")]) };
    },
  };
  let raw = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    raw = Buffer.from((JSON.parse(String(init.body)) as { raw: string }).raw, "base64url").toString("utf8");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const tokens: ConnectorTokenSource = { connectorAccessToken: async () => "tok" };
  const result = await gmailAdapter.act({ owner: "sina@acme.co", tokens, fetchImpl, files }, item, "send", {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(opened, ["art-1"]);
  const mixed = raw.match(/Content-Type: multipart\/mixed; boundary="([^"]+)"/)![1]!;
  const parts = raw.split(`--${mixed}`);
  assert.equal(parts.length, 4, "preamble, alternative body, one attachment, closing");
  assert.match(parts[1]!, /Content-Type: multipart\/alternative/);
  assert.match(
    parts[2]!,
    /Content-Type: text\/csv; name="q3 _pricing_\.csv"\r\nContent-Disposition: attachment; filename="q3 _pricing_\.csv"/,
  );
  const payload = parts[2]!.split("\r\n\r\n")[1]!.replaceAll("\r\n", "").replace(/--$/, "");
  assert.equal(Buffer.from(payload, "base64").toString("utf8"), "seat,price\n1,2");

  const gone = await gmailAdapter.act(
    { owner: "sina@acme.co", tokens, fetchImpl, files: { open: async () => null } },
    item,
    "send",
    {},
  );
  assert.deepEqual(gone, {
    ok: false,
    reason: "bad_item",
    message: 'attachment "q3 "pricing".csv" is no longer available; remove it and send again',
  });

  const huge = {
    open: async () => ({
      artifact: {} as never,
      sizeBytes: MAX_ATTACHMENT_BYTES + 1,
      stream: Readable.from([Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]),
    }),
  };
  const tooBig = await gmailAdapter.act({ owner: "sina@acme.co", tokens, fetchImpl, files: huge }, item, "send", {});
  assert.equal(tooBig.ok, false);
  assert.match((tooBig as { message: string }).message, /exceed 5 MB/);
  assert.equal(buildGmailReplyMime(item, { body: "x", to: ["a@b.co"] })?.includes("multipart/mixed"), false);
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
    (tool!.execute as unknown as (id: string, p: unknown) => Promise<{ content: Array<{ text?: string }> }>)(
      "t",
      params,
    );
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

test("send_email stages workspace files for the email and refuses when staging fails", async () => {
  const seen: unknown[] = [];
  const { run, emitted } = toolsWith({
    async attachEmailFiles(paths) {
      seen.push(paths);
      if (paths.includes("missing.pdf")) return { ok: false, message: "couldn't attach: missing.pdf (not found)" };
      return {
        ok: true,
        staged: 1,
        files: [{ name: "report.pdf", mimetype: "application/pdf", sizeBytes: 2048, artifactId: "art-9" }],
      };
    },
    async holdEmailDraft(draft) {
      seen.push(draft);
      return { loopId: "l1", itemId: "i1" };
    },
  });
  const bad = await run({ to: ["a@b.co"], subject: "x", body: "y", attachments: ["missing.pdf"] });
  assert.match(bad.content[0]?.text ?? "", /missing\.pdf \(not found\)/);
  const ok = await run({ to: ["a@b.co"], subject: "x", body: "y", attachments: [" report.pdf "] });
  assert.match(ok.content[0]?.text ?? "", /handed to the user/);
  assert.deepEqual(seen.at(-2), ["report.pdf"]);
  assert.deepEqual((seen.at(-1) as { attachments: unknown }).attachments, [
    { artifactId: "art-9", name: "report.pdf", mimetype: "application/pdf", sizeBytes: 2048 },
  ]);
  const persisted = emitted.filter((e) => e.type === "tool_result").at(-1)!.payload;
  assert.deepEqual(persisted.attachments, ["report.pdf"]);

  const noStaging = toolsWith({
    async holdEmailDraft() {
      return { loopId: "l1", itemId: "i1" };
    },
  });
  const refused = await noStaging.run({ to: ["a@b.co"], subject: "x", body: "y", attachments: ["a.txt"] });
  assert.match(refused.content[0]?.text ?? "", /attachments are not available/);
});

test("send_email rejects malformed input before it reaches the ledger", async () => {
  const { run, emitted } = toolsWith({
    async holdEmailDraft() {
      throw new Error("must not be called");
    },
  });
  const bad = await run({ to: ["not-an-address"], subject: "x", body: "y" });
  assert.match(bad.content[0]?.text ?? "", /not an email address/);
  const badCc = await run({ to: ["Dana <dana@northwind.io>"], cc: ["priya at acme"], subject: "x", body: "y" });
  assert.match(badCc.content[0]?.text ?? "", /"priya at acme" is not an email address/);
  const noSubject = await run({ to: ["a@b.co"], subject: " ", body: "y" });
  assert.match(noSubject.content[0]?.text ?? "", /needs a subject/);
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
