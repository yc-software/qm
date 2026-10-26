import { createHash } from "node:crypto";
import type { ScopeId, Session, SessionType, SpawnMeta } from "../types.ts";
import { isUserMessage, type Item, type NewItem } from "./items.ts";
import { sleep } from "../util/async.ts";
import type { GoalRecord } from "../harness/goal.ts";

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
  return item.kind === "ContextCompaction" && item.throughSeq !== null && item.text !== null
    ? { throughSeq: item.throughSeq, text: item.text }
    : null;
}

export function contextSummaryItem(throughSeq: number, text: string): NewItem<"ContextCompaction"> {
  return { kind: "ContextCompaction", throughSeq, text };
}

export interface ContextWindow {
  items: Item[];
  totalItems: number;
}

export function contextWindowFromItems(items: Item[]): ContextWindow {
  let throughSeq: number | undefined;
  for (const item of items) throughSeq = contextSummary(item)?.throughSeq ?? throughSeq;
  return {
    items: throughSeq === undefined ? [...items] : items.filter((item) => item.seq > throughSeq),
    totalItems: items.length,
  };
}

export interface Lease {
  sessionId: string;
  token: string;
  turnId?: string;
  fenceToken?: string;
}

export type LeaseHolder = "turn" | "compaction" | "fork" | "backfill";

export interface LeaseAttempt {
  lease: Lease | null;
  heldBy?: LeaseHolder;
  heldSince?: number;
  heldUntil?: number;
}

export interface LeasePeek {
  holder?: LeaseHolder;
  heldUntil: number;
}

export interface AcquireLeaseWaitOptions {
  waitFor?: (heldBy: LeaseHolder | undefined) => boolean;
}

const LEASE_WAIT_MIN_DELAY_MS = 25;
const LEASE_WAIT_MAX_DELAY_MS = 1_000;

export async function acquireLeaseWithin(
  sessions: Pick<SessionStore, "acquireLease" | "peekLease">,
  sessionId: string,
  holder: LeaseHolder,
  budgetMs: number,
  opts?: AcquireLeaseWaitOptions,
): Promise<LeaseAttempt & { waitedMs?: number }> {
  const started = Date.now();
  const deadline = started + budgetMs;
  let delay = LEASE_WAIT_MIN_DELAY_MS;
  for (;;) {
    const waitedMs = Date.now() - started;
    const attempt = await sessions.acquireLease(sessionId, holder);
    if (attempt.lease) return { ...attempt, waitedMs };
    if (attempt.heldUntil === undefined) return { ...attempt, waitedMs };
    if (opts?.waitFor && !opts.waitFor(attempt.heldBy)) return { ...attempt, waitedMs };
    for (;;) {
      if (Date.now() + LEASE_WAIT_MIN_DELAY_MS > deadline) return { ...attempt, waitedMs: Date.now() - started };
      await sleep(Math.min(delay, deadline - Date.now()));
      delay = Math.min(delay * 2, LEASE_WAIT_MAX_DELAY_MS);
      const seen = await sessions.peekLease(sessionId);
      if (!seen || seen.heldUntil <= Date.now()) break;
    }
  }
}

export interface StoreOptions {
  now?: () => number;
  leaseTtlMs?: number;
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

export type GapPhase =
  | "provision"
  | "creds"
  | "dir_cleanup"
  | "proc_reconcile"
  | "auth_probe"
  | "skills_materialize"
  | "recall"
  | "memory_write"
  | "file_op"
  | "exec"
  | "model_dispatch"
  | "dispatch_glue"
  | "loop_reentry"
  | "context_assemble"
  | "glue_other"
  | "tool_body"
  | "pre_tool"
  | "in_tool_untagged"
  | "post_tool"
  | "tool_ledger"
  | "persist"
  | "stream_open";

export interface GapWork {
  phase: GapPhase;
  start: number;
  end: number;
  tool?: string;
}

export type GapPhases = Partial<Record<GapPhase, number>> & {
  residual?: number;
} & {
  [key: `tool_body.${string}`]: number | undefined;
};

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
  ttftMs: number | null;
  durationMs: number | null;
  stepGapMs: number | null;
  toolWallMs: number[] | null;
  gapPhases: GapPhases | null;
  usage: LlmCallUsage | null;
  transport: LlmTransportMeta | null;
}

/** A past security screening, recovered from its captured request — the replay corpus for flagger tests. */
export interface ScreenSample {
  id: string;
  sessionId: string;
  scopeLabel: ScopeId;
  createdAt: number;
  model: string;
  payload: string;
}

export interface NewLlmRequest {
  turnSeq: number | null;
  step: number;
  model: string;
  scopeLabel: ScopeId;
  promptEnvelope?: unknown;
  truncated?: boolean;
  ttftMs?: number | null;
  durationMs?: number | null;
  stepGapMs?: number | null;
  toolWallMs?: number[] | null;
  gapPhases?: GapPhases | null;
  usage?: LlmCallUsage | null;
  transport?: LlmTransportMeta | null;
}

export interface ParticipantWindow {
  sessionId: string;
  principalId: string;
  validFrom: number;
  validTo: number | null;
  validFromSeq: number | null;
  validToSeq: number | null;
}

export function itemWithinTenure(
  entry: Pick<Item, "seq" | "createdAt">,
  window: Pick<ParticipantWindow, "validFrom" | "validTo" | "validFromSeq" | "validToSeq">,
): boolean {
  const fromOk = window.validFromSeq !== null ? entry.seq >= window.validFromSeq : entry.createdAt >= window.validFrom;
  const toOk =
    window.validToSeq !== null
      ? entry.seq < window.validToSeq
      : window.validTo === null || entry.createdAt < window.validTo;
  return fromOk && toOk;
}

export interface AttributedTurn {
  principalId: string;
  sessionId: string;
  day: number;
  turns: number;
  firstAt: number;
  lastAt: number;
}

export type SessionOrigin = "conversation" | "cron" | "webhook" | "monitor" | "loop" | "swarm";

export const stableOriginPattern = (origin: string): string => `^agent:main:${origin}:[^:]+$`;
export const legacyOriginPattern = (origin: string): string => `^${origin}:[^:]+(:.+)?$`;
export const ORIGIN_ALTERNATION = "(cron|webhook|monitor|loop|swarm)";
const STABLE_CRON_ID_PATTERN = "^agent:main:cron:([^:]+)$";
const LEGACY_CRON_ID_PATTERN = "^cron:([^:]+)(:.+)?$";
export const threadRefCronIdExpr = (threadRef: string): string =>
  `COALESCE(substring(${threadRef} FROM '${STABLE_CRON_ID_PATTERN}'), substring(${threadRef} FROM '${LEGACY_CRON_ID_PATTERN}'))`;

const STABLE_ORIGIN_RE = new RegExp(stableOriginPattern(ORIGIN_ALTERNATION));
const LEGACY_ORIGIN_RE = new RegExp(legacyOriginPattern(ORIGIN_ALTERNATION));
const STABLE_CRON_ID_RE = new RegExp(STABLE_CRON_ID_PATTERN);
const LEGACY_CRON_ID_RE = new RegExp(LEGACY_CRON_ID_PATTERN);

export function sessionOrigin(threadRef: string | null | undefined): SessionOrigin {
  const stable = STABLE_ORIGIN_RE.exec(threadRef ?? "");
  if (stable) return stable[1] as SessionOrigin;
  const legacy = LEGACY_ORIGIN_RE.exec(threadRef ?? "");
  if (legacy) return legacy[1] as SessionOrigin;
  return "conversation";
}

export function sessionCategory(origin: SessionOrigin): SessionCategory {
  return origin === "conversation" ? "conversation" : "background";
}

export function cronIdOf(threadRef: string | null | undefined): string | null {
  const m = STABLE_CRON_ID_RE.exec(threadRef ?? "") ?? LEGACY_CRON_ID_RE.exec(threadRef ?? "");
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

export type SearchHitType = "user" | "assistant" | "text";

export interface EntrySearchHit extends Pick<Session, "scopeId" | "title" | "channelName" | "surface" | "archived"> {
  sessionId: string;
  seq: number;
  type: SearchHitType;
  author?: string;
  text: string;
  createdAt: number;
}

export interface NewSearchEntry {
  seq: number;
  type: SearchHitType;
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

export function userMessagePreview(text: string | null | undefined, maxLen = 160): string {
  const raw = text ?? "";
  const kept =
    raw
      .split("\n\n")
      .filter((p) => !/^\s*\[/.test(p))
      .join("\n\n")
      .trim() || raw.trim();
  const oneLine = kept.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

export const ENTRY_STRING_BUDGET = 2_000;

export type TranscriptItem = Item & { truncated?: true };

const MODEL_ONLY_FIELDS: Partial<Record<Item["kind"], ReadonlySet<string>>> = {
  UserMessage: new Set(["environment", "environmentSnapshot", "memoryRecall"]),
  SteeringMessage: new Set(["environment", "environmentSnapshot", "memoryRecall"]),
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

function postsToTheConversation(item: Item): boolean {
  return item.kind === "ToolCall" && item.body.action === "post";
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
  if ((item.kind !== "ToolCall" && item.kind !== "ToolResult") || postsToTheConversation(item)) return item;
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
      if (!isUserMessage(items[i]!)) continue;
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

interface AddParticipantOptions {
  includeHistory?: boolean;
}

export interface SessionStore {
  getOrCreateByThread(
    threadRef: string,
    type: SessionType,
    scopeId: ScopeId,
    channelName?: string,
    surface?: string,
    clientTools?: Session["clientTools"],
  ): Promise<Session>;
  getByThread(threadRef: string): Promise<Session | null>;
  get(sessionId: string): Promise<Session | null>;

  updateTitle(sessionId: string, title: string): Promise<void>;
  setParentSession(sessionId: string, parentSessionId: string | null): Promise<void>;
  setSpawnMeta(sessionId: string, meta: SpawnMeta): Promise<void>;
  childrenOf(parentSessionId: string): Promise<Session[]>;
  updateForkProvenance(
    sessionId: string,
    provenance: { forkedFrom: { sessionId: string; title?: string | null }; forkBoundarySeq: number },
  ): Promise<void>;

  readonly leaseTtlMs: number;
  acquireLease(sessionId: string, holder?: LeaseHolder): Promise<LeaseAttempt>;
  peekLease(sessionId: string): Promise<LeasePeek | null>;
  renewLease(lease: Lease): Promise<boolean>;
  releaseLease(lease: Lease): Promise<void>;
  forceReleaseLease(sessionId: string): Promise<void>;

  append(lease: Lease, item: NewItem): Promise<Item>;
  appendMany(lease: Lease, items: readonly NewItem[]): Promise<Item[]>;
  getItems(sessionId: string, opts?: GetItemsOptions): Promise<Item[]>;
  hasDeliveryEntry(sessionId: string, deliveryKey: string, slackTs?: string): Promise<boolean>;
  countItemsBefore(sessionId: string, beforeSeq: number, principalId?: string): Promise<number>;
  getContextWindow(sessionId: string): Promise<ContextWindow>;
  getItem(sessionId: string, seq: number): Promise<Item | undefined>;
  latestItemSeq(sessionId: string): Promise<number>;
  goals(sessionIds: readonly string[]): Promise<Map<string, GoalRecord>>;
  setGoal(lease: Lease, goal: GoalRecord, notices?: readonly NewItem[]): Promise<void>;

  recordLlmRequest(sessionId: string, rec: NewLlmRequest, signal?: AbortSignal): Promise<LlmRequestRecord>;
  listLlmRequests(sessionId: string, opts?: ListLlmRequestsOptions): Promise<LlmRequestRecord[]>;
  /** The most recent security screenings across every scope, newest first. */
  listScreenSamples(limit: number): Promise<ScreenSample[]>;
  purgeLlmCaptures?(cutoff: number, opts?: { deadline?: number; stop?: () => boolean }): Promise<number>;

  addParticipant(sessionId: string, principalId: string, title?: string, opts?: AddParticipantOptions): Promise<void>;
  removeParticipant(sessionId: string, principalId: string): Promise<void>;
  listByParticipant(principalId: string, opts?: { limit: number }): Promise<Session[]>;
  participantScopes(principalId: string): Promise<ParticipantScope[]>;
  listParticipantPage(principalId: string, query: ParticipantPageQuery): Promise<ParticipantPage>;
  descendantsOf(rootIds: readonly string[]): Promise<SessionDescendant[]>;
  listDescendantsForParticipant(rootId: string, principalId: string, limit: number): Promise<Session[]>;
  getForParticipant(sessionId: string, principalId: string): Promise<Session | null>;

  deleteSession(sessionId: string): Promise<void>;
  deleteSessionIfEmpty(sessionId: string): Promise<boolean>;

  updateParticipantView(sessionId: string, principalId: string, patch: ParticipantViewPatch): Promise<void>;

  addPin(sessionId: string, pin: NewSessionPin, maxPins?: number): Promise<SessionPin | null>;
  listPins(sessionId: string): Promise<SessionPin[]>;
  removePin(sessionId: string, pinId: string): Promise<boolean>;

  visibleItems(sessionId: string, principalId: string, opts?: GetItemsOptions): Promise<Item[]>;

  searchEntries(principalId: string, query: string, limit?: number): Promise<EntrySearchHit[]>;

  /** Sessions whose (participant or session) title contains the query — newest activity first. */
  searchSessionTitles(principalId: string, query: string, limit?: number): Promise<Session[]>;

  scanAll(): Promise<Session[]>;

  countSessions(): Promise<number>;

  listByScope(scope: ScopeId): Promise<Session[]>;

  scopeHasSessions(scope: ScopeId): Promise<boolean>;

  sessionsByThreadRefs(threadRefs: readonly string[]): Promise<SessionRef[]>;

  distinctScopes(): Promise<DistinctScope[]>;

  scopeSessionSummaries(scope: ScopeId, orgWide: boolean, page: SessionPage): Promise<SessionSummary[]>;

  scopeActivity(): Promise<ScopeActivity[]>;

  scopeConversationCount(scope: ScopeId): Promise<number>;

  attributedTurns(): Promise<AttributedTurn[]>;

  spendRollup(range: { from: number; to: number }): Promise<SpendRow[]>;

  spendReport?(range: { from: number; to: number }): Promise<{ rows: SpendRow[]; asOf?: number }>;

  refreshSpendRollup?(): Promise<void>;

  listParticipants(): Promise<ParticipantWindow[]>;

  distinctParticipants(): Promise<string[]>;

  participantWindowsOf(sessionId: string): Promise<ParticipantWindow[]>;

  participantsOf(sessionId: string): Promise<string[]>;
}
