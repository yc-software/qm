import type { LoopItem, LoopSourcePayload } from "../../types.ts";

export interface ConnectorTokenSource {
  connectorAccessToken(host: string, principalId: string, accountType?: string): Promise<string | null>;
}

export interface SlackUserClient {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string; parse?: "none" | "full" }): Promise<unknown>;
  };
  reactions: { add(args: { channel: string; timestamp: string; name: string }): Promise<unknown> };
}

export interface SourceActionDeps {
  owner: string;
  actor?: "human" | "agent";
  tokens: ConnectorTokenSource;
  fetchImpl?: typeof fetch;
  slackClient?: (token: string) => SlackUserClient;
}

export type SourceActionResult =
  | { ok: true; result: string; resolves?: boolean; payloadPatch?: LoopSourcePayload }
  | { ok: false; reason: "not_connected" | "bad_item" | "upstream"; message: string; partial?: boolean };

export interface ConversationEvent {
  source: string;

  conversationRef: string;

  at: number;
  text?: string;
  senderEmail?: string;
}

export interface ParsedEntry {
  dedupeKey: string;
  summary: string;
  sourcePayload: LoopSourcePayload;
  sourceAt: number;
  proposal?: { data: LoopSourcePayload; summary?: string };
}

export interface LoopSourceAdapter {
  id: string;
  actions: readonly string[];
  parse(raw: Record<string, unknown>): ParsedEntry | { error: string };

  matchesEvent(item: LoopItem, conversationRef: string): boolean;
  parseProposal(raw: unknown): LoopSourcePayload | null;
  act(deps: SourceActionDeps, item: LoopItem, kind: string, args: LoopSourcePayload): Promise<SourceActionResult>;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function clipOpt(v: unknown, max: number): string | undefined {
  return clip(v, max) ?? undefined;
}

export function addressList(v: unknown, maxEntries = 10): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const entry of v.slice(0, maxEntries)) {
    const s = clip(entry, 200);
    if (s) out.push(s);
  }
  return out.length ? out : undefined;
}

function httpUrl(v: unknown): string | undefined {
  const s = clip(v, 600);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") return s;
  } catch {
    return undefined;
  }
  return undefined;
}

interface MessageContext {
  author: string;
  at?: number;
  text: string;
  images?: string[];
}

function parseImageUrls(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const entry of v.slice(0, 4)) {
    const url = httpUrl(entry);
    if (url) out.push(url);
  }
  return out.length ? out : undefined;
}

function parseContext(v: unknown): MessageContext[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: MessageContext[] = [];
  for (const entry of v.slice(0, 8)) {
    if (!isObj(entry)) continue;
    const author = clip(entry.author, 120);
    const text = clip(entry.text, 1000);
    if (!author || !text) continue;
    const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : undefined;
    const images = parseImageUrls(entry.images);
    out.push({ author, text, ...(at !== undefined ? { at } : {}), ...(images ? { images } : {}) });
  }
  return out.length ? out : undefined;
}

export interface ReplyDraft {
  to?: string[];
  cc?: string[];
  subject?: string;
  body: string;
}

export function parseReplyDraft(v: unknown): ReplyDraft | null {
  if (!isObj(v)) return null;
  const body = typeof v.body === "string" ? v.body.slice(0, 20000) : null;
  if (body === null) return null;
  const to = addressList(v.to);
  const cc = addressList(v.cc);
  const subject = clipOpt(v.subject, 300);
  return { body, ...(to ? { to } : {}), ...(cc ? { cc } : {}), ...(subject ? { subject } : {}) };
}

export function draftOf(item: LoopItem): ReplyDraft | null {
  return parseReplyDraft(item.proposal?.data);
}

export interface CommonSourceFields {
  title: string;
  from: string;
  fromDetail?: string;
  snippet: string;
  context?: MessageContext[];
  receivedAt: number;
  externalUrl?: string;
  probablyResolved?: boolean;
  images?: string[];
}

export function parseCommonFields(raw: Record<string, unknown>): CommonSourceFields | { error: string } {
  const title = clip(raw.title, 300);
  if (!title) return { error: "title required" };
  const from = clip(raw.from, 120);
  if (!from) return { error: "from required" };
  const snippet = clip(raw.snippet, 500);
  if (!snippet) return { error: "snippet required" };
  const receivedAt = typeof raw.receivedAt === "number" && Number.isFinite(raw.receivedAt) ? raw.receivedAt : null;
  if (receivedAt === null || receivedAt <= 0) return { error: "receivedAt (ms epoch) required" };
  const fromDetail = clipOpt(raw.fromDetail, 200);
  const context = parseContext(raw.context);
  const externalUrl = httpUrl(raw.externalUrl);
  const probablyResolved = raw.probablyResolved === true;
  const images = parseImageUrls(raw.images);
  return {
    title,
    from,
    snippet,
    receivedAt,
    ...(fromDetail ? { fromDetail } : {}),
    ...(context ? { context } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(probablyResolved ? { probablyResolved } : {}),
    ...(images ? { images } : {}),
  };
}

export async function tokenFor(tokens: ConnectorTokenSource, host: string, owner: string): Promise<string | null> {
  return (
    (await tokens.connectorAccessToken(host, owner, "personal")) ??
    (await tokens.connectorAccessToken(host, owner)) ??
    (await tokens.connectorAccessToken(host, owner, "company"))
  );
}
