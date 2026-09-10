import type { LoopItem, LoopSourcePayload } from "../../types.ts";
import { randomUUID } from "node:crypto";
import { errMessage } from "../../util/errors.ts";
import { emailHtml, emailPlainText } from "../../../plugins/chassis/src/email-markdown.ts";
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

export const GMAIL_HOST = "gmail.googleapis.com";

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
  const meta = metaOf(item);
  const original = meta?.subject?.trim() ?? titleOf(item).trim();
  if (!meta) return original;
  if (!original) return "Re:";
  return /^re:/i.test(original) ? original : `Re: ${original}`;
}

export interface MimeAttachment {
  name: string;
  mimetype: string;
  bytes: Uint8Array;
}

export const MAX_EMAIL_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_FILENAME_CHARS = 150;

function textPart(type: string, text: string): string[] {
  return [
    `Content-Type: ${type}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(new TextEncoder().encode(text))),
  ];
}

function alternativePart(body: string, boundary: string): string[] {
  return [
    `--${boundary}`,
    ...textPart("text/plain", emailPlainText(body)),
    `--${boundary}`,
    ...textPart("text/html", emailHtml(body)),
    `--${boundary}--`,
  ];
}

function filenameParams(name: string): string {
  const trimmed = name.slice(0, MAX_FILENAME_CHARS);
  const ascii = trimmed.replace(/[^\x20-\x7e]|["\\]/g, "_");
  if (ascii === trimmed) return `filename="${ascii}"`;
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(trimmed)}`;
}

function attachmentPart(file: MimeAttachment): string[] {
  return [
    `Content-Type: ${file.mimetype}`,
    `Content-Disposition: attachment; ${filenameParams(file.name)}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(file.bytes)),
  ];
}

export function buildGmailReplyMime(item: LoopItem, draft: ReplyDraft, files: MimeAttachment[] = []): string | null {
  const meta = metaOf(item);
  const to = (draft.to?.length ? draft.to : meta?.to) ?? [];
  if (to.length === 0) return null;
  const cc = draft.cc ?? meta?.cc ?? [];
  const rfcId = meta?.rfcMessageId;
  const alt = `alt-${randomUUID()}`;
  const mixed = `mixed-${randomUUID()}`;
  const headers = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${headerValue(replySubject(item, draft))}`,
    ...(rfcId ? [`In-Reply-To: ${rfcId}`, `References: ${rfcId}`] : []),
    "MIME-Version: 1.0",
  ];
  const body = files.length
    ? [
        `Content-Type: multipart/mixed; boundary="${mixed}"`,
        "",
        `--${mixed}`,
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        "",
        ...alternativePart(draft.body, alt),
        ...files.flatMap((file) => [`--${mixed}`, ...attachmentPart(file)]),
        `--${mixed}--`,
      ]
    : [`Content-Type: multipart/alternative; boundary="${alt}"`, "", ...alternativePart(draft.body, alt)];
  return [...headers, ...body].join("\r\n");
}

async function loadAttachments(
  deps: SourceActionDeps,
  draft: ReplyDraft,
): Promise<{ ok: true; files: MimeAttachment[] } | { ok: false; message: string }> {
  const wanted = draft.attachments ?? [];
  if (!wanted.length) return { ok: true, files: [] };
  if (!deps.files) return { ok: false, message: "attachments are not available on this deployment" };
  const tooLarge = `attachments exceed ${Math.floor(MAX_EMAIL_ATTACHMENT_BYTES / 1024 / 1024)} MB in total`;
  const files: MimeAttachment[] = [];
  let total = 0;
  for (const a of wanted) {
    const opened = await deps.files.open(a.artifactId);
    if (!opened)
      return { ok: false, message: `attachment "${a.name}" is no longer available; remove it and send again` };
    total += opened.sizeBytes;
    if (total > MAX_EMAIL_ATTACHMENT_BYTES) {
      opened.stream.destroy();
      return { ok: false, message: tooLarge };
    }
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    total += Math.max(0, bytes.length - opened.sizeBytes);
    if (total > MAX_EMAIL_ATTACHMENT_BYTES) return { ok: false, message: tooLarge };
    files.push({ name: opened.name, mimetype: opened.mimetype, bytes });
  }
  return { ok: true, files };
}

async function sendGmail(deps: SourceActionDeps, item: LoopItem, draft: ReplyDraft): Promise<SourceActionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await tokenFor(deps.tokens, GMAIL_HOST, deps.owner);
  if (!token) return { ok: false, reason: "not_connected", message: "Google is not connected for this account" };
  const loaded = await loadAttachments(deps, draft);
  if (!loaded.ok) return { ok: false, reason: "bad_item", message: loaded.message };
  const mime = buildGmailReplyMime(item, draft, loaded.files);
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
