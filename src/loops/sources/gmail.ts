import MailComposer from "nodemailer/lib/mail-composer";
import type { LoopItem, LoopSourcePayload } from "../../types.ts";
import { isAccountType } from "../../connectors/oauth.ts";
import { GmailApiError, gmailApi } from "../../connectors/gmail-api.ts";
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

function metaOf(item: LoopItem): GmailMeta | undefined {
  return parseGmailMeta(item.sourcePayload?.gmail);
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

export async function buildGmailReplyMime(item: LoopItem, draft: ReplyDraft): Promise<Buffer | null> {
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
    text: parsed.body,
    textEncoding: "base64",
  })
    .compile()
    .build();
}

async function sendGmail(deps: SourceActionDeps, item: LoopItem, draft: ReplyDraft): Promise<SourceActionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const meta = metaOf(item);
  if (!meta) return { ok: false, reason: "bad_item", message: "invalid Gmail metadata" };
  const accountType = meta.accountType ?? (item.sourcePayload?.sentChat === true ? "default" : undefined);
  const token = accountType
    ? await deps.tokens.connectorAccessToken(GMAIL_HOST, deps.owner, accountType)
    : await tokenFor(deps.tokens, GMAIL_HOST, deps.owner);
  if (!token) return { ok: false, reason: "not_connected", message: "Google is not connected for this account" };
  const mime = await buildGmailReplyMime(item, draft);
  if (!mime) return { ok: false, reason: "bad_item", message: "no recipient — add a To: address to the draft" };
  const threadId = metaOf(item)?.threadId;
  try {
    await gmailApi(token, fetchImpl)("messages/send", {
      timeoutMs: 30_000,
      body: {
        raw: mime.toString("base64url"),
        ...(threadId ? { threadId } : {}),
      },
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
    const draft = args.body !== undefined ? parseReplyDraft(args) : draftOf(item);
    if (!draft || !draft.body.trim()) return { ok: false, reason: "bad_item", message: "the draft is empty" };
    try {
      return await sendGmail(deps, item, { ...draft, body: draft.body.trim() });
    } catch (err) {
      return { ok: false, reason: "upstream", message: errMessage(err) };
    }
  },
};
