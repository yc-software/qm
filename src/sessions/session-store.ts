import { createHash } from "node:crypto";
import type { TenantLookup } from "../tenants/lookup.ts";
import type { ScopeId, Session, SessionType, SpawnMeta } from "../types.ts";
import type { GoalRecord } from "../agent/goal.ts";
import { isUserItem, type Item, type NewItem } from "./items.ts";

export const LLM_CAPTURE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function promptEnvelopeBody(envelope: unknown): { hash: string; body: string } | null {
  if (envelope == null) return null;
  let body: string;
  try {
    body = JSON.stringify(envelope);
  } catch {
    return null;
  }
  if (body === undefined) return null;
  return { hash: createHash("sha256").update(body).digest("hex"), body };
}

export function contextSummary(item: Item): { throughSeq: number; text: string } | null {
  return item.kind === "ContextCompaction" && item.throughSeq !== null
    ? { throughSeq: item.throughSeq, text: item.text ?? "" }
    : null;
}

interface ContextWindow {
  items: Item[];
  totalItems: number;
}

export interface SessionWriter {
  sessionId: string;
  turnId?: string;
  runLeaseToken?: string;
}

export interface StoreOptions {
  now?: () => number;
}

interface ParticipantViewPatch {
  title?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string | null;
  readAt?: number;
}

export interface NewSessionPin {
  text?: string;
  entrySeq?: number;
  addedBy: string;
}

export interface SessionPin extends NewSessionPin {
  id: string;
  sessionId: string;
  createdAt: number;
}

export const isWebThread = (threadRef: string): boolean => threadRef.startsWith("web:");

export interface GetItemsOptions {
  messagesOnly?: boolean;
  transcript?: boolean;
  turnId?: string;
  sinceSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

export type SessionCategory = "conversation" | "background";
export type SessionOriginFilter = SessionOrigin | "other_background";

interface ListLlmRequestsOptions {
  turnSeqs?: number[];
  orphans?: boolean;
  omitRequest?: boolean;
}

export interface SessionPage {
  limit: number;
  before?: { lastActivity: number; id: string };
  category?: SessionCategory;
  origin?: SessionOriginFilter;
  cronId?: string;
  signal?: AbortSignal;
}

export interface ScopeActivity {
  scopeId: ScopeId;
  conversations: number;
  crons: number;
  background: number;
  lastActivity: number;
}

export interface SpendRow {
  day: number;
  model: string | null;
  scopeId: ScopeId;
  origin: SessionOrigin;
  cronId: string | null;
  calls: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LlmCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

export interface LlmTransportMeta {
  modelId?: string;
  headers?: Record<string, string>;
}

export interface LlmRequestRecord {
  id: string;
  sessionId: string;
  turnSeq: number | null;
  step: number;
  model: string;
  scopeLabel: ScopeId;
  createdAt: number;
  promptHash: string | null;
  promptEnvelope?: unknown;
  truncated: boolean;
  usage: LlmCallUsage | null;
  transport: LlmTransportMeta | null;
}

export interface NewLlmRequest {
  turnSeq: number | null;
  step: number;
  model: string;
  scopeLabel: ScopeId;
  promptEnvelope?: unknown;
  truncated?: boolean;
  usage?: LlmCallUsage | null;
  transport?: LlmTransportMeta | null;
}

export interface Participant {
  sessionId: string;
  principalId: string;
}

export type SessionOrigin = "conversation" | "cron" | "webhook" | "monitor" | "loop" | "swarm";

const ORIGINS = "(cron|webhook|monitor|loop|swarm)";
const STABLE_ORIGIN_RE = new RegExp(`^agent:main:${ORIGINS}:[^:]+$`);
const BARE_ORIGIN_RE = new RegExp(`^${ORIGINS}:[^:]+(:.+)?$`);
const STABLE_CRON_ID_RE = /^agent:main:cron:([^:]+)$/;
const BARE_CRON_ID_RE = /^cron:([^:]+)(:.+)?$/;

export function sessionOrigin(threadRef: string | null | undefined): SessionOrigin {
  const stable = STABLE_ORIGIN_RE.exec(threadRef ?? "");
  if (stable) return stable[1] as SessionOrigin;
  const bare = BARE_ORIGIN_RE.exec(threadRef ?? "");
  if (bare) return bare[1] as SessionOrigin;
  return "conversation";
}

export function sessionCategory(origin: SessionOrigin): SessionCategory {
  return origin === "conversation" ? "conversation" : "background";
}

export function cronIdOf(threadRef: string | null | undefined): string | null {
  const m = STABLE_CRON_ID_RE.exec(threadRef ?? "") ?? BARE_CRON_ID_RE.exec(threadRef ?? "");
  return m ? m[1]! : null;
}

export interface SessionRef {
  id: string;
  threadRef: string;
  scopeId: ScopeId;
  type: SessionType;
  title?: string | null;
}

export interface DistinctScope {
  scopeId: ScopeId;
  channelName?: string;
}

export interface ParticipantPageQuery {
  limit: number;
  before?: { activity: number; id: string };
  archived?: boolean;
  pinned?: boolean;
  surface?: string;
  scopeId?: ScopeId;
  titleQuery?: string;
  sessionIds?: readonly string[];
}

export interface ParticipantPage {
  sessions: Session[];
  next: { activity: number; id: string } | null;
}

export interface ToolStep {
  tool: string;
  at: number;
  purpose?: string;
}

export interface SessionDescendant {
  id: string;
  rootId: string;
  threadRef: string;
}

export interface ParticipantScope {
  scopeId: ScopeId;
  channelName?: string;
  sessionCount: number;
  lastActivityAt: number | null;
}

export interface EntrySearchHit extends Pick<Session, "scopeId" | "title" | "channelName" | "surface" | "archived"> {
  sessionId: string;
  seq: number;
  type: "user" | "text" | "assistant";
  author?: string;
  text: string;
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  type: SessionType;
  origin: SessionOrigin;
  scopeId: ScopeId;
  threadRef: string;
  turns: number;
  messages: number;
  lastActivity: number;
  createdAt: number;
  firstMessage: string;
  lastMessage: string;
}

export function userMessagePreview(text: string, maxLen = 160): string {
  const kept =
    text
      .split("\n\n")
      .filter((p) => !/^\s*\[/.test(p))
      .join("\n\n")
      .trim() || text.trim();
  const oneLine = kept.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

export const ENTRY_STRING_BUDGET = 2_000;

export type TranscriptItem = Item & { truncated?: true };

const MESSAGE_MODEL_CONTEXT: ReadonlySet<string> = new Set([
  "environment",
  "environmentSnapshot",
  "rosterSnapshot",
  "memoryRecall",
  "memoryRecallOutcomes",
]);
const MODEL_ONLY_FIELDS: Partial<Record<Item["kind"], ReadonlySet<string>>> = {
  UserMessage: MESSAGE_MODEL_CONTEXT,
  SteeringMessage: MESSAGE_MODEL_CONTEXT,
  Reasoning: new Set(["thinkingSignature"]),
};
const WALK_DEPTH = 8;

function shortenStrings(value: unknown, depth: number): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    return value.length > ENTRY_STRING_BUDGET
      ? { value: value.slice(0, ENTRY_STRING_BUDGET), truncated: true }
      : { value, truncated: false };
  }
  if (value === null || typeof value !== "object") return { value, truncated: false };
  if (depth >= WALK_DEPTH) {
    return payloadBytes(value, depth) > ENTRY_STRING_BUDGET
      ? { value: null, truncated: true }
      : { value, truncated: false };
  }
  let truncated = false;
  if (Array.isArray(value)) {
    const next = value.map((item) => {
      const walked = shortenStrings(item, depth + 1);
      truncated ||= walked.truncated;
      return walked.value;
    });
    return truncated ? { value: next, truncated } : { value, truncated };
  }
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const walked = shortenStrings(item, depth + 1);
    truncated ||= walked.truncated;
    next[key] = walked.value;
  }
  return truncated ? { value: next, truncated } : { value, truncated };
}

function withoutModelContext(item: Item, fields: ReadonlySet<string>): TranscriptItem {
  if (!Object.keys(item.body).some((k) => fields.has(k))) return item;
  return {
    ...item,
    body: Object.fromEntries(Object.entries(item.body).filter(([k]) => !fields.has(k))),
    truncated: true,
  };
}

function projectItem(item: Item): TranscriptItem {
  const modelOnly = MODEL_ONLY_FIELDS[item.kind];
  if (modelOnly) return withoutModelContext(item, modelOnly);
  if (
    (item.kind !== "ToolCall" && item.kind !== "ToolResult") ||
    (item.kind === "ToolCall" && item.body.action === "post")
  )
    return item;
  const body = shortenStrings(item.body, 0);
  const text = shortenStrings(item.text, 0);
  if (!body.truncated && !text.truncated) return item;
  return { ...item, body: body.value as Record<string, unknown>, text: text.value as string | null, truncated: true };
}

function payloadBytes(value: unknown, depth: number): number {
  if (typeof value === "string") return value.length + 2;
  if (value === null || typeof value !== "object") return 8;
  if (depth >= WALK_DEPTH) {
    try {
      return JSON.stringify(value)?.length ?? 8;
    } catch {
      return 8;
    }
  }
  let bytes = 2;
  if (Array.isArray(value)) {
    for (const item of value) bytes += payloadBytes(item, depth + 1) + 1;
    return bytes;
  }
  for (const [key, item] of Object.entries(value)) bytes += key.length + payloadBytes(item, depth + 1) + 4;
  return bytes;
}

export function windowedTranscript(
  items: Item[],
  window?: { tailTurns?: number; sinceSeq?: number; beforeSeq?: number },
): { items: TranscriptItem[]; earlier: number } {
  if (window?.beforeSeq !== undefined) {
    const at = items.findIndex((e) => e.seq >= window.beforeSeq!);
    items = items.slice(0, at < 0 ? items.length : at);
  }
  let cut = 0;
  if (window?.sinceSeq !== undefined) {
    const at = items.findIndex((e) => e.seq >= window.sinceSeq!);
    cut = at < 0 ? items.length : at;
  } else if (window?.tailTurns !== undefined && window.tailTurns > 0) {
    let turns = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      if (!isUserItem(items[i]!)) continue;
      if (++turns === window.tailTurns) {
        cut = i;
        break;
      }
    }
  }
  return { items: (cut > 0 ? items.slice(cut) : items).map(projectItem), earlier: cut };
}

export class DuplicateCallError extends Error {
  constructor(sessionId: string, callIds: readonly string[], options?: { cause?: unknown }) {
    super(`session ${sessionId} already records one of calls ${callIds.join(", ")}`, options);
    this.name = "DuplicateCallError";
  }
}

interface SessionFacts {
  surfaceBinding?: Session["surfaceBinding"];
  context?: SpawnMeta;
}

export interface SessionStore {
  tenantLookup: TenantLookup;
  getOrCreateByThread(
    threadRef: string,
    type: SessionType,
    scopeId: ScopeId,
    channelName?: string,
    surface?: string,
    clientTools?: Session["clientTools"],
    facts?: SessionFacts,
  ): Promise<Session>;
  getByThread(threadRef: string): Promise<Session | null>;
  get(sessionId: string): Promise<Session | null>;

  updateTitle(sessionId: string, title: string): Promise<void>;
  setParentSession(sessionId: string, parentSessionId: string | null): Promise<void>;
  setSpawnMeta(sessionId: string, meta: SpawnMeta): Promise<void>;
  setRuntime(sessionId: string, runtime: NonNullable<Session["runtime"]>): Promise<void>;
  setPersona(sessionId: string, personaId: string | null): Promise<void>;
  threadsWithPersona(personaId: string, threadRefs: readonly string[]): Promise<Set<string>>;
  endedInFailure(sessionIds: readonly string[]): Promise<Set<string>>;
  childrenOf(parentSessionId: string): Promise<Session[]>;
  sideChatsOf(sessionId: string): Promise<Session[]>;
  expandSideChat(sessionId: string): Promise<void>;
  updateForkProvenance(
    sessionId: string,
    provenance: {
      forkedFrom: { sessionId: string; title?: string | null };
      forkBoundarySeq: number;
      sideChat?: Session["sideChat"];
    },
  ): Promise<void>;

  append(writer: SessionWriter, item: NewItem): Promise<Item>;
  appendMany(writer: SessionWriter, items: readonly NewItem[]): Promise<Item[]>;
  getItems(sessionId: string, opts?: GetItemsOptions): Promise<Item[]>;
  hasDeliveryEntry(sessionId: string, deliveryKey: string, slackTs?: string): Promise<boolean>;
  countItemsBefore(sessionId: string, beforeSeq: number, principalId?: string): Promise<number>;
  getContextWindow(sessionId: string): Promise<ContextWindow>;
  getItem(sessionId: string, seq: number): Promise<Item | undefined>;
  latestItemSeq(sessionId: string): Promise<number>;
  latestToolSteps(turnIds: readonly string[]): Promise<Map<string, ToolStep>>;
  goals(sessionIds: readonly string[]): Promise<Map<string, GoalRecord>>;
  setGoal(writer: SessionWriter, goal: GoalRecord, notices?: readonly NewItem[]): Promise<void>;

  recordLlmRequest(sessionId: string, rec: NewLlmRequest): Promise<LlmRequestRecord>;
  listLlmRequests(sessionId: string, opts?: ListLlmRequestsOptions): Promise<LlmRequestRecord[]>;
  purgeLlmCaptures?(cutoff: number, opts?: { deadline?: number; stop?: () => boolean }): Promise<number>;

  addParticipant(sessionId: string, principalId: string, title?: string): Promise<void>;
  removeParticipant(sessionId: string, principalId: string): Promise<void>;
  listByParticipant(principalId: string, opts?: { limit: number }): Promise<Session[]>;
  participantScopes(principalId: string): Promise<ParticipantScope[]>;
  listParticipantPage(principalId: string, query: ParticipantPageQuery): Promise<ParticipantPage>;
  descendantsOf(rootIds: readonly string[]): Promise<SessionDescendant[]>;
  inheritedOrigin(session: Pick<Session, "id" | "parentSessionId">): Promise<SessionOrigin>;
  listDescendantsForParticipant(rootId: string, principalId: string, limit: number): Promise<Session[]>;
  getForParticipant(sessionId: string, principalId: string): Promise<Session | null>;
  sameScopeAncestors(threadRefs: readonly string[]): Promise<Session[]>;

  deleteSession(sessionId: string): Promise<void>;
  deleteSessionIfEmpty(sessionId: string): Promise<boolean>;

  updateParticipantView(sessionId: string, principalId: string, patch: ParticipantViewPatch): Promise<void>;

  addPin(sessionId: string, pin: NewSessionPin, maxPins?: number): Promise<SessionPin | null>;
  listPins(sessionId: string): Promise<SessionPin[]>;
  removePin(sessionId: string, pinId: string): Promise<boolean>;

  visibleItems(sessionId: string, principalId: string, opts?: GetItemsOptions): Promise<Item[]>;

  searchEntries(principalId: string, query: string, limit?: number): Promise<EntrySearchHit[]>;

  searchSessionTitles(principalId: string, query: string, limit?: number): Promise<Session[]>;

  countSessions(): Promise<number>;

  listByScope(scope: ScopeId): Promise<Session[]>;

  scopeHasSessions(scope: ScopeId): Promise<boolean>;

  sessionsByThreadRefs(threadRefs: readonly string[]): Promise<SessionRef[]>;

  distinctScopes(): Promise<DistinctScope[]>;

  scopeSessionSummaries(scope: ScopeId, orgWide: boolean, page: SessionPage): Promise<SessionSummary[]>;

  scopeActivity(): Promise<ScopeActivity[]>;

  scopeConversationCount(scope: ScopeId): Promise<number>;

  spendRollup(range: { from: number; to: number }): Promise<SpendRow[]>;

  spendReport?(range: { from: number; to: number }): Promise<{ rows: SpendRow[]; asOf?: number }>;

  refreshSpendRollup?(): Promise<void>;

  listParticipants(): Promise<Participant[]>;

  distinctParticipants(): Promise<string[]>;

  participantsOf(sessionId: string): Promise<string[]>;
}
