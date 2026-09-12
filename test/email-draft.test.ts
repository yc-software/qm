import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { holdEmailDraft } from "../src/loops/email-draft.ts";
import { findInboxLoop } from "../src/loops/inbox-loop.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { ledgerState } from "../src/loops/ledger-view.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import type { ConnectorTokenSource } from "../src/loops/sources/adapter.ts";
import {
  buildGmailReplyMime,
  gmailAdapter,
  MAX_EMAIL_ATTACHMENT_BYTES,
  replySubject,
} from "../src/loops/sources/gmail.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { EntryType } from "../src/types.ts";

const DRAFT = {
  to: ["dana@northwind.io"],
  cc: ["priya@acme.co"],
  subject: "Q3 pricing",
  body: "Hi Dana,\n\nShort answer: no.",
};

const tokens: ConnectorTokenSource = { connectorAccessToken: async () => "tok" };

function capturingFetch(): { fetchImpl: typeof fetch; sent: () => { threadId?: string; mime: string } } {
  let body: { raw: string; threadId?: string } = { raw: "" };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    sent: () => ({ threadId: body.threadId, mime: Buffer.from(body.raw, "base64url").toString("utf8") }),
  };
}

test("holdEmailDraft files a held gmail compose item in the owner's inbox loop, one per hand-off", async () => {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const held = await holdEmailDraft({ loops, items }, "sina@acme.co", DRAFT, "s1");
  const loop = await findInboxLoop(loops, "sina@acme.co");
  assert.equal(held.loopId, loop!.id);
  const item = (await items.get(held.itemId))!;
  assert.equal(item.source, "gmail");
  assert.equal(ledgerState(item), "held");
  assert.equal(item.sourcePayload?.compose, true);
  assert.equal(item.sourcePayload?.gmail, undefined);
  assert.deepEqual(item.proposal, { data: DRAFT, by: "agent", at: item.proposal!.at, sessionId: "s1" });
  const again = await holdEmailDraft({ loops, items }, "sina@acme.co", DRAFT);
  assert.notEqual(again.itemId, held.itemId);
});

test("a compose item sends as a fresh plain-text message: no Re:, no thread", async () => {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const held = await holdEmailDraft({ loops, items }, "sina@acme.co", DRAFT);
  const item = (await items.get(held.itemId))!;
  assert.equal(replySubject(item, { body: "x" }), "Q3 pricing");
  assert.doesNotMatch(buildGmailReplyMime(item, { body: "x", to: ["a@b.co"] }) ?? "", /In-Reply-To|multipart/);
  const { fetchImpl, sent } = capturingFetch();
  const result = await gmailAdapter.act({ owner: "sina@acme.co", tokens, fetchImpl }, item, "send", {});
  assert.equal(result.ok, true);
  assert.equal(sent().threadId, undefined);
  assert.match(sent().mime, /^To: dana@northwind\.io\r\nCc: priya@acme\.co\r\nSubject: Q3 pricing\r\n/);
  const encoded = sent().mime.split("\r\n\r\n")[1]!;
  assert.equal(Buffer.from(encoded.replaceAll("\r\n", ""), "base64").toString("utf8"), DRAFT.body);
});

test("attachments ride along as multipart/mixed built from the stored artifacts, within a size cap", async () => {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const attachment = { artifactId: "art-1", name: "forged.exe", mimetype: "text/plain\r\nX-Evil: 1", sizeBytes: 12 };
  const held = await holdEmailDraft({ loops, items }, "sina@acme.co", { ...DRAFT, attachments: [attachment] });
  const item = (await items.get(held.itemId))!;
  assert.deepEqual((item.proposal!.data as { attachments: unknown }).attachments, [
    { ...attachment, mimetype: "application/octet-stream" },
  ]);
  const files = {
    open: async (id: string) =>
      id === "art-1"
        ? {
            name: 'q3 "préis".csv',
            mimetype: "text/csv",
            sizeBytes: 12,
            stream: Readable.from([Buffer.from("a,b\n1,2")]),
          }
        : null,
  };
  const { fetchImpl, sent } = capturingFetch();
  const result = await gmailAdapter.act({ owner: "sina@acme.co", tokens, fetchImpl, files }, item, "send", {});
  assert.equal(result.ok, true, JSON.stringify(result));
  const boundary = sent().mime.match(/Content-Type: multipart\/mixed; boundary="([^"]+)"/)![1]!;
  const parts = sent().mime.split(`--${boundary}`);
  assert.equal(parts.length, 4);
  assert.match(parts[1]!, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(
    parts[2]!,
    /Content-Type: text\/csv\r\nContent-Disposition: attachment; filename="q3 _pr_is_\.csv"; filename\*=UTF-8''q3%20%22pr%C3%A9is%22\.csv\r\n/,
  );
  const payload = parts[2]!.split("\r\n\r\n")[1]!.replaceAll("\r\n", "").replace(/--$/, "");
  assert.equal(Buffer.from(payload, "base64").toString("utf8"), "a,b\n1,2");

  const missing = { open: async () => null };
  const gone = await gmailAdapter.act({ owner: "sina@acme.co", tokens, fetchImpl, files: missing }, item, "send", {});
  assert.match((gone as { message: string }).message, /"forged\.exe" is no longer available/);
  const oversize = {
    ...files,
    open: async () => ({ ...(await files.open("art-1"))!, sizeBytes: MAX_EMAIL_ATTACHMENT_BYTES + 1 }),
  };
  const tooBig = await gmailAdapter.act(
    { owner: "sina@acme.co", tokens, fetchImpl, files: oversize },
    item,
    "send",
    {},
  );
  assert.match((tooBig as { message: string }).message, /exceed 5 MB/);
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
  const run = async (params: unknown) => {
    const out = await (
      tool!.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text?: string }[] }>
    )("t", params);
    return out.content[0]?.text ?? "";
  };
  return { tool, run, emitted };
}

test("send_email hands the draft over, stages attachments, and paints the ref for the UI without sending", async () => {
  const seen: unknown[] = [];
  const { tool, run, emitted } = toolsWith({
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
  assert.ok(tool);
  assert.match(
    await run({ to: [" dana@northwind.io "], subject: " Q3 pricing ", body: "Hi Dana\n" }),
    /held for the user/,
  );
  assert.deepEqual(seen, [{ to: ["dana@northwind.io"], subject: "Q3 pricing", body: "Hi Dana" }]);
  const persisted = emitted.find((e) => e.type === "tool_result")!.payload;
  assert.equal(persisted.isError, false);
  assert.deepEqual(persisted.display, { emailDraft: { loopId: "l1", itemId: "i1" } });

  assert.match(await run({ to: ["a@b.co"], subject: "x", body: "y", attachments: ["missing.pdf"] }), /missing\.pdf/);
  assert.match(
    await run({ to: ["a@b.co"], subject: "x", body: "y", attachments: [" report.pdf "] }),
    /held for the user/,
  );
  assert.deepEqual(seen.at(-2), ["report.pdf"]);
  assert.deepEqual(seen.at(-1), {
    to: ["a@b.co"],
    subject: "x",
    body: "y",
    attachments: [{ artifactId: "art-9", name: "report.pdf", mimetype: "application/pdf", sizeBytes: 2048 }],
  });
  const many = Array.from({ length: 11 }, (_, i) => `f${i}`);
  assert.match(await run({ to: ["a@b.co"], subject: "x", body: "y", attachments: many }), /at most 10 attachments/);
});

test("send_email rejects malformed input, is offered only when the turn can hold drafts, and explains otherwise", async () => {
  const { run } = toolsWith({
    async holdEmailDraft() {
      throw new Error("must not be called");
    },
  });
  assert.match(await run({ to: ["not-an-address"], subject: "x", body: "y" }), /not an email address/);
  assert.match(
    await run({ to: ["Dana <dana@northwind.io>"], cc: ["priya at acme"], subject: "x", body: "y" }),
    /"priya at acme"/,
  );
  assert.match(await run({ to: ["a@b.co"], subject: " ", body: "y" }), /needs a subject/);
  assert.match(await run({ to: [], subject: "x", body: "y" }), /at least one recipient/);
  assert.equal(toolsWith({}, false).tool, undefined);
  assert.match(await toolsWith({}).run({ to: ["a@b.co"], subject: "x", body: "y" }), /Gmail is not connected/);
});
