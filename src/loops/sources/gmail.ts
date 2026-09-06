import type { LoopItem, LoopSourcePayload } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import {
  addressList,
  clip,
  clipOpt,
  draftOf,
  isObj,
  parseCommonFields,
  parseReplyDraft,
  tokenFor,
  type LoopSourceAdapter,
  type ParsedEntry,
  type ReplyDraft,
  type SourceActionDeps,
  type SourceActionResult,
} from "./adapter.ts";

const GMAIL_HOST = "gmail.googleapis.com";

interface GmailMeta {
  threadId: string;
  messageId?: string;
  rfcMessageId?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
}

function parseGmailMeta(v: unknown): GmailMeta | undefined {
  if (!isObj(v)) return undefined;
  const threadId = clip(v.threadId, 200);
  if (!threadId) return undefined;
  const messageId = clipOpt(v.messageId, 200);
  const rfcMessageId = clipOpt(v.rfcMessageId, 400);
  const to = addressList(v.to);
  const cc = addressList(v.cc);
  const subject = clipOpt(v.subject, 300);
  return {
    threadId,
    ...(messageId ? { messageId } : {}),
    ...(rfcMessageId ? { rfcMessageId } : {}),
    ...(to ? { to } : {}),
    ...(cc ? { cc } : {}),
    ...(subject ? { subject } : {}),
  };
}

function metaOf(item: LoopItem): GmailMeta | undefined {
  return parseGmailMeta(item.sourcePayload?.gmail);
}

function titleOf(item: LoopItem): string {
  return clip(item.sourcePayload?.title, 300) ?? "";
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function isAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

function headerValue(s: string): string {
  if (isAscii(s)) return s;
  return `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`;
}

function wrap76(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

export function replySubject(item: LoopItem, draft: ReplyDraft): string {
  const explicit = draft.subject?.trim();
  if (explicit) return explicit;
  const original = metaOf(item)?.subject?.trim() ?? titleOf(item).trim();
  if (!original) return "Re:";
  return /^re:/i.test(original) ? original : `Re: ${original}`;
}

export function buildGmailReplyMime(item: LoopItem, draft: ReplyDraft): string | null {
  const meta = metaOf(item);
  const to = (draft.to?.length ? draft.to : meta?.to) ?? [];
  if (to.length === 0) return null;
  const cc = draft.cc ?? meta?.cc ?? [];
  const rfcId = meta?.rfcMessageId;
  const lines = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${headerValue(replySubject(item, draft))}`,
    ...(rfcId ? [`In-Reply-To: ${rfcId}`, `References: ${rfcId}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(new TextEncoder().encode(draft.body))),
  ];
  return lines.join("\r\n");
}

async function sendGmail(deps: SourceActionDeps, item: LoopItem, draft: ReplyDraft): Promise<SourceActionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await tokenFor(deps.tokens, GMAIL_HOST, deps.owner);
  if (!token) return { ok: false, reason: "not_connected", message: "Google is not connected for this account" };
  const mime = buildGmailReplyMime(item, draft);
  if (!mime) return { ok: false, reason: "bad_item", message: "no recipient — add a To: address to the draft" };
  const threadId = metaOf(item)?.threadId;
  const res = await fetchImpl(`https://${GMAIL_HOST}/gmail/v1/users/me/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      raw: Buffer.from(mime, "utf8").toString("base64url"),
      ...(threadId ? { threadId } : {}),
    }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, reason: "upstream", message: `Gmail refused the send (${res.status}): ${text}` };
  }
  return { ok: true, result: draft.body };
}

export const gmailAdapter: LoopSourceAdapter = {
  id: "gmail",
  actions: ["send"],
  parse(raw) {
    const common = parseCommonFields(raw);
    if ("error" in common) return common;
    const dedupeKey = clip(raw.sourceKey ?? raw.dedupeKey, 300);
    if (!dedupeKey) return { error: "sourceKey required" };
    const gmail = parseGmailMeta(raw.gmail);
    if (!gmail) return { error: "gmail items need gmail.threadId" };
    const draft = raw.draft === undefined ? undefined : parseReplyDraft(raw.draft);
    if (draft === null) return { error: "draft needs a string body" };
    const entry: ParsedEntry = {
      dedupeKey,
      summary: common.snippet,
      sourceAt: common.receivedAt,
      sourcePayload: { source: "gmail", ...common, gmail } as LoopSourcePayload,
      ...(draft ? { proposal: { data: draft as unknown as LoopSourcePayload } } : {}),
    };
    return entry;
  },
  matchesEvent(item, conversationRef) {
    return metaOf(item)?.threadId === conversationRef;
  },
  parseProposal(raw) {
    const draft = parseReplyDraft(raw);
    return draft ? (draft as unknown as LoopSourcePayload) : null;
  },
  async act(deps, item, kind, args) {
    if (kind !== "send") return { ok: false, reason: "bad_item", message: `gmail items do not support "${kind}"` };
    const draft = parseReplyDraft(args) ?? draftOf(item);
    if (!draft || !draft.body.trim()) return { ok: false, reason: "bad_item", message: "the draft is empty" };
    try {
      return await sendGmail(deps, item, { ...draft, body: draft.body.trim() });
    } catch (err) {
      return { ok: false, reason: "upstream", message: errMessage(err) };
    }
  },
};
