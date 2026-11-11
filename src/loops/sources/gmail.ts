import MailComposer from "nodemailer/lib/mail-composer";
import type { LoopItem, LoopSourcePayload } from "../types.ts";
import { isAccountType } from "../../connectors/oauth.ts";
import { GmailApiError, gmailApi, gmailHeader, gmailPartText } from "../../connectors/gmail-api.ts";
import { escapeHtml } from "../../../plugins/chassis/src/http.ts";
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
  type ConnectorTokenSource,
  type LoopSourceAdapter,
  type ParsedEntry,
  type ReplyDraft,
  type SourceActionDeps,
  type SourceActionResult,
} from "./adapter.ts";

const GMAIL_HOST = "gmail.googleapis.com";

interface GmailMeta {
  threadId: string;
  accountType?: "default" | "personal" | "company";
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
  if (v.accountType !== undefined && !isAccountType(v.accountType)) return undefined;
  const accountType = v.accountType as GmailMeta["accountType"];
  const messageId = clipOpt(v.messageId, 200);
  const rfcMessageId = clipOpt(v.rfcMessageId, 400);
  const to = addressList(v.to);
  const cc = addressList(v.cc);
  if (to === null || cc === null) return undefined;
  const subject = clipOpt(v.subject, 300);
  return {
    threadId,
    ...(accountType ? { accountType } : {}),
    ...(messageId ? { messageId } : {}),
    ...(rfcMessageId ? { rfcMessageId } : {}),
    ...(to ? { to } : {}),
    ...(cc ? { cc } : {}),
    ...(subject ? { subject } : {}),
  };
}

export function gmailThreadOf(item: LoopItem): string | undefined {
  return metaOf(item)?.threadId;
}

function metaOf(item: LoopItem): GmailMeta | undefined {
  return parseGmailMeta(item.sourcePayload?.gmail);
}

export function gmailAccountOf(item: LoopItem): GmailMeta["accountType"] {
  return metaOf(item)?.accountType;
}

export async function gmailToken(tokens: ConnectorTokenSource, owner: string, item: LoopItem): Promise<string | null> {
  const accountType = gmailAccountOf(item);
  return accountType
    ? await tokens.connectorAccessToken(GMAIL_HOST, owner, accountType)
    : await tokenFor(tokens, GMAIL_HOST, owner);
}

function titleOf(item: LoopItem): string {
  return clip(item.sourcePayload?.title, 300) ?? "";
}

export function replySubject(item: LoopItem, draft: ReplyDraft): string {
  const explicit = draft.subject?.trim();
  if (explicit) return explicit;
  const original = metaOf(item)?.subject?.trim() ?? titleOf(item).trim();
  if (!original) return "Re:";
  return /^re:/i.test(original) ? original : `Re: ${original}`;
}

export interface GmailQuote {
  text: string;
  html: string;
}

const htmlMirror = (text: string): string => `<div dir="ltr">${text.split("\n").map(escapeHtml).join("<br>")}</div>`;

const quoteLine = (line: string): string => {
  if (line.startsWith(">")) return `>${line}`;
  return line ? `> ${line}` : ">";
};

export function gmailQuote(message: Record<string, unknown>): GmailQuote {
  const payload = isObj(message.payload) ? message.payload : {};
  const attribution = `On ${gmailHeader(payload, "Date")} ${gmailHeader(payload, "From")} wrote:`;
  const plain = (gmailPartText(payload) ?? (typeof message.snippet === "string" ? message.snippet : ""))
    .replaceAll("\r\n", "\n")
    .trim();
  const rich = gmailPartText(payload, "text/html");
  const quoted = rich && !rich.toLowerCase().includes("<body") ? rich : htmlMirror(plain);
  return {
    text: `${attribution}\n\n${plain.split("\n").map(quoteLine).join("\n")}`,
    html:
      `<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${quoted}</blockquote></div>`,
  };
}

export async function buildGmailReplyMime(
  item: LoopItem,
  draft: ReplyDraft,
  quote?: GmailQuote,
): Promise<Buffer | null> {
  const meta = metaOf(item);
  if (!meta) return null;
  const parsed = parseReplyDraft(draft);
  if (!parsed) return null;
  const to = parsed.to ?? meta.to ?? [];
  if (to.length === 0) return null;
  const rfcId = meta.rfcMessageId;
  return new MailComposer({
    to,
    cc: parsed.cc ?? meta.cc ?? [],
    subject: replySubject(item, parsed),
    ...(rfcId ? { inReplyTo: rfcId, references: rfcId } : {}),
    text: quote ? `${parsed.body}\n\n${quote.text}` : parsed.body,
    html: htmlMirror(parsed.body) + (quote?.html ?? ""),
    textEncoding: "base64",
  })
    .compile()
    .build();
}

async function repliedMessage(api: ReturnType<typeof gmailApi>, meta: GmailMeta): Promise<Record<string, unknown>> {
  const thread = await api<{ messages?: unknown[] }>(`threads/${encodeURIComponent(meta.threadId)}?format=full`);
  const messages = (thread.messages ?? [])
    .filter(isObj)
    .filter((m) => !(Array.isArray(m.labelIds) && m.labelIds.includes("DRAFT")));
  const own = messages.find((m) => m.id === meta.messageId);
  const latest = own ?? messages.at(-1);
  if (!latest) throw new GmailApiError(`threads/${meta.threadId}`, 404, 0, "thread has no messages");
  return latest;
}

async function sendGmail(deps: SourceActionDeps, item: LoopItem, draft: ReplyDraft): Promise<SourceActionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const meta = metaOf(item);
  if (!meta) return { ok: false, reason: "bad_item", message: "invalid Gmail metadata" };
  const token = await gmailToken(deps.tokens, deps.owner, item);
  if (!token) return { ok: false, reason: "not_connected", message: "Google is not connected for this account" };
  if (!(await buildGmailReplyMime(item, draft)))
    return { ok: false, reason: "bad_item", message: "no recipient — add a To: address to the draft" };
  const api = gmailApi(token, fetchImpl);
  let quote: GmailQuote;
  try {
    quote = gmailQuote(await repliedMessage(api, meta));
  } catch (error) {
    if (!(error instanceof GmailApiError)) throw error;
    return {
      ok: false,
      reason: "upstream",
      message: `Gmail refused reading the thread to quote it (${error.status}): ${error.detail}`,
    };
  }
  const mime = (await buildGmailReplyMime(item, draft, quote))!;
  try {
    await api("messages/send", {
      timeoutMs: 30_000,
      body: { raw: mime.toString("base64url"), threadId: meta.threadId },
    });
  } catch (error) {
    if (!(error instanceof GmailApiError)) throw error;
    return { ok: false, reason: "upstream", message: `Gmail refused the send (${error.status}): ${error.detail}` };
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
      sourcePayload: { ...common, gmail } as LoopSourcePayload,
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
    const draft = args.body !== undefined ? parseReplyDraft(args) : draftOf(item);
    if (!draft || !draft.body.trim()) return { ok: false, reason: "bad_item", message: "the draft is empty" };
    try {
      return await sendGmail(deps, item, { ...draft, body: draft.body.trim() });
    } catch (err) {
      return { ok: false, reason: "upstream", message: errMessage(err) };
    }
  },
};
