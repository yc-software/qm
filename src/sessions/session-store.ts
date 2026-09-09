import { createHash } from "node:crypto";
import type { EntryType, ScopeId, Session, SessionEntry, SessionType } from "../types.ts";
import { sleep } from "../util/async.ts";

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

const CONTEXT_SUMMARY_KIND = "context_summary";

export interface ContextSummaryPayload {
  kind: typeof CONTEXT_SUMMARY_KIND;
  throughSeq: number;
  text: string;
}

export function contextSummaryPayload(entry: SessionEntry): ContextSummaryPayload | null {
  const payload = entry.payload as Partial<ContextSummaryPayload> | null;
  if (
    entry.type === "system" &&
    payload?.kind === CONTEXT_SUMMARY_KIND &&
    typeof payload.throughSeq === "number" &&
    typeof payload.text === "string"
  ) {
    return { kind: CONTEXT_SUMMARY_KIND, throughSeq: payload.throughSeq, text: payload.text };
  }
  return null;
}

export function createContextSummaryPayload(throughSeq: number, text: string): ContextSummaryPayload {
  return { kind: CONTEXT_SUMMARY_KIND, throughSeq, text };
}

export interface ContextWindow {
  entries: SessionEntry[];
  totalEntries: number;
  hasSecurityTaint: boolean;
}

export function entrySecurityTainted(entry: SessionEntry): boolean {
  return (entry.payload as { securityTainted?: unknown } | null)?.securityTainted === true;
}

export function contextWindowFromEntries(entries: SessionEntry[]): ContextWindow {
  let latest: ContextSummaryPayload | null = null;
  for (const entry of entries) latest = contextSummaryPayload(entry) ?? latest;
  const throughSeq = latest?.throughSeq;
  return {
    entries: throughSeq === undefined ? [...entries] : entries.filter((entry) => entry.seq > throughSeq),
    totalEntries: entries.length,
    hasSecurityTaint: entries.some(entrySecurityTainted),
  };
}

export interface Lease {
  sessionId: string;
  token: string;
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

export interface NewEntry {
  type: EntryType;
  payload: unknown;
  scopeLabel: ScopeId;
}

interface ParticipantViewPatch {
  title?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string | null;
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

type TapeKind = "message" | "context_event" | "annotation";

export const TAPE_RENDER_VERSION = 1;

export interface TapeCheckpointEntry {
  type: EntryType;
  payload: unknown;
  at: number;
}

export function tapeCheckpointPayload(
  bound: "turnEnd" | "subturnEnd",
  entry?: TapeCheckpointEntry,
  spanStart?: number,
): Record<string, unknown> {
  return {
    [bound]: true,
    render: TAPE_RENDER_VERSION,
    ...(entry ? { entry } : {}),
    ...(spanStart !== undefined ? { spanStart } : {}),
  };
}

export function tapeEntryMirrorRecord(entry: {
  seq: number;
  createdAt: number;
  type: string;
  payload: unknown;
  scopeLabel: ScopeId;
}): NewTapeRecord {
  return {
    kind: "annotation",
    payload: { entry: { type: entry.type, payload: entry.payload, at: entry.createdAt } },
    scopeLabel: entry.scopeLabel,
    entrySeq: entry.seq,
  };
}

export type TranscriptAppendSessions = Pick<SessionStore, "append" | "appendTape" | "latestEntrySeq" | "tapeCoverage">;

export async function appendEntryOutsideTurn(
  sessions: TranscriptAppendSessions,
  lease: Lease,
  entry: NewEntry,
  modelText?: (appended: SessionEntry) => string,
): Promise<SessionEntry> {
  const tapeContiguous =
    (await sessions.tapeCoverage(lease.sessionId)) === (await sessions.latestEntrySeq(lease.sessionId));
  const appended = await sessions.append(lease, entry);
  if (!tapeContiguous) return appended;
  if (modelText) {
    await sessions.appendTape(lease, {
      kind: "message",
      payload: { role: "user", content: [{ type: "text", text: modelText(appended) }], timestamp: appended.createdAt },
      scopeLabel: entry.scopeLabel,
      meta: { entryCreatedAt: appended.createdAt },
    });
  }
  await sessions.appendTape(lease, {
    kind: "annotation",
    payload: tapeCheckpointPayload("turnEnd", { type: entry.type, payload: entry.payload, at: appended.createdAt }),
    scopeLabel: entry.scopeLabel,
    entrySeq: appended.seq,
  });
  return appended;
}

export const TAPE_IMPORT_MAX_ENTRIES = 500;

export interface TapeMeta {
  bareText?: string;
  ts?: string;
  changeTime?: string;
  hidden?: boolean;
  overheard?: boolean;
  author?: string;
  attachments?: unknown[];
  display?: string;
  securityTainted?: boolean;
  entryCreatedAt?: number;
}

export interface NewTapeRecord {
  kind: TapeKind;
  payload: unknown;
  scopeLabel: ScopeId;
  harness?: string;
  meta?: TapeMeta;
  entrySeq?: number;
  coversEntrySeq?: number;
}

export interface TapeRecord extends NewTapeRecord {
  sessionId: string;
  seq: number;
  createdAt: number;
}

export interface GetTapeOptions {
  sinceSeq?: number;
  limit?: number;
}

export interface GetEntriesOptions {
  sinceSeq?: number;
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
  offset: number;
  before?: { lastActivity: number; id: string };
  category?: SessionCategory;
  origin?: SessionOriginFilter;
  cronId?: string;
}

export interface CronGroupSummary {
  cronId: string;
  scopeId: ScopeId;
  sessions: number;
  turns: number;
  messages: number;
  lastActivity: number;
  createdAt: number;
}

export interface ScopeSessionRollup {
  scopeId: ScopeId;
  sessions: number;
  backgroundSessions: number;
  lastActivity: number;
  lastConversationActivity: number;
  previewSessionId: string | null;
}

export interface ScopeSessionStats {
  total: number;
  turns: number;
  byType: Record<string, number>;
  byTypeAll: Record<string, number>;
  totalByCategory: Record<SessionCategory | "all", number>;
  crons: number;
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
  request: unknown;
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

export function entryWithinTenure(
  entry: Pick<SessionEntry, "seq" | "createdAt">,
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

export type SessionOrigin = "conversation" | "cron" | "webhook" | "monitor";

export const stableOriginPattern = (origin: string): string => `^agent:main:${origin}:[^:]+$`;
export const legacyOriginPattern = (origin: string): string => `^${origin}:[^:]+(:.+)?$`;
export const ORIGIN_ALTERNATION = "(cron|webhook|monitor)";
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

export function sessionBucket(origin: SessionOrigin, type: SessionType): string {
  return origin === "conversation" ? type : origin;
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

export interface EntrySearchHit extends Pick<Session, "scopeId" | "title" | "channelName" | "surface" | "archived"> {
  sessionId: string;
  seq: number;
  type: EntryType;
  author?: string;
  text: string;
  createdAt: number;
}

export interface NewSearchEntry {
  seq: number;
  type: EntryType;
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

export function userMessagePreview(payload: unknown, maxLen = 160): string {
  let text = "";
  if (typeof payload === "string") text = payload;
  else if (payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string") {
    text = (payload as { text: string }).text;
  }
  const kept =
    text
      .split("\n\n")
      .filter((p) => !/^\s*\[/.test(p))
      .join("\n\n")
      .trim() || text.trim();
  const oneLine = kept.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

export function transcriptEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  return entries.filter((e) => e.type !== "soul");
}

export const TRANSCRIPT_BYTE_BUDGET = 400_000;
export const ENTRY_STRING_BUDGET = 2_000;

export type TranscriptEntry = SessionEntry & { truncated?: true };

const PROJECTED_TYPES: ReadonlySet<EntryType> = new Set<EntryType>(["tool_call", "tool_result"]);
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

function postsToTheConversation(entry: SessionEntry): boolean {
  const p = entry.payload as { action?: unknown } | null;
  return entry.type === "tool_call" && p?.action === "post";
}

function projectEntry(entry: SessionEntry): TranscriptEntry {
  if (!PROJECTED_TYPES.has(entry.type) || postsToTheConversation(entry)) return entry;
  const walked = shortenStrings(entry.payload, 0);
  return walked.truncated ? { ...entry, payload: walked.value, truncated: true } : entry;
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
  entries: SessionEntry[],
  window?: { tailTurns?: number; sinceSeq?: number; beforeSeq?: number },
): { entries: TranscriptEntry[]; earlier: number } {
  if (window?.beforeSeq !== undefined) {
    const at = entries.findIndex((e) => e.seq >= window.beforeSeq!);
    entries = entries.slice(0, at < 0 ? entries.length : at);
  }
  let cut = 0;
  if (window?.sinceSeq !== undefined) {
    const at = entries.findIndex((e) => e.seq >= window.sinceSeq!);
    cut = at < 0 ? entries.length : at;
  } else if (window?.tailTurns !== undefined && window.tailTurns > 0) {
    let turns = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.type !== "user") continue;
      if (++turns === window.tailTurns) {
        cut = i;
        break;
      }
    }
  }
  const windowed = (cut > 0 ? entries.slice(cut) : entries).map(projectEntry);
  if (window === undefined || window.sinceSeq !== undefined) return { entries: windowed, earlier: cut };
  let spend = 0;
  let from = windowed.length;
  while (from > 0) {
    const bytes = payloadBytes(windowed[from - 1]!.payload, 0);
    if (spend + bytes > TRANSCRIPT_BYTE_BUDGET && from < windowed.length) break;
    spend += bytes;
    from--;
  }
  if (from > 0) {
    const boundary = windowed.findIndex((e, i) => i >= from && e.type === "user");
    if (boundary > 0) from = boundary;
  }
  return { entries: from > 0 ? windowed.slice(from) : windowed, earlier: cut + from };
}

export function isOverheardEntry(e: Pick<SessionEntry, "type" | "payload">): boolean {
  return e.type === "user" && (e.payload as { overheard?: unknown } | null)?.overheard === true;
}

export function entryDeliveryKey(entry: Pick<SessionEntry, "payload">): string | undefined {
  const key = (entry.payload as { deliveryKey?: unknown } | null)?.deliveryKey;
  return typeof key === "string" ? key : undefined;
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
  ): Promise<Session>;
  getByThread(threadRef: string): Promise<Session | null>;
  get(sessionId: string): Promise<Session | null>;

  updateTitle(sessionId: string, title: string): Promise<void>;
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

  append(lease: Lease, entry: NewEntry): Promise<SessionEntry>;
  getEntries(sessionId: string, opts?: GetEntriesOptions): Promise<SessionEntry[]>;
  getContextWindow(sessionId: string): Promise<ContextWindow>;
  getEntry(sessionId: string, seq: number): Promise<SessionEntry | undefined>;
  latestEntrySeq(sessionId: string): Promise<number>;
  clearSecurityTaint(sessionId: string): Promise<boolean>;

  appendTape(lease: Lease, rec: NewTapeRecord): Promise<TapeRecord>;
  getTape(sessionId: string, opts?: GetTapeOptions): Promise<TapeRecord[]>;
  tapeCoverage(sessionId: string): Promise<number>;

  recordLlmRequest(sessionId: string, rec: NewLlmRequest, signal?: AbortSignal): Promise<LlmRequestRecord>;
  listLlmRequests(sessionId: string, opts?: ListLlmRequestsOptions): Promise<LlmRequestRecord[]>;
  /** The most recent security screenings across every scope, newest first. */
  listScreenSamples(limit: number): Promise<ScreenSample[]>;

  addParticipant(sessionId: string, principalId: string, title?: string, opts?: AddParticipantOptions): Promise<void>;
  removeParticipant(sessionId: string, principalId: string): Promise<void>;
  listByParticipant(principalId: string, opts?: { limit: number }): Promise<Session[]>;
  getForParticipant(sessionId: string, principalId: string): Promise<Session | null>;

  deleteSession(sessionId: string): Promise<void>;
  deleteSessionIfEmpty(sessionId: string): Promise<boolean>;

  updateParticipantView(sessionId: string, principalId: string, patch: ParticipantViewPatch): Promise<void>;

  addPin(sessionId: string, pin: NewSessionPin, maxPins?: number): Promise<SessionPin | null>;
  listPins(sessionId: string): Promise<SessionPin[]>;
  removePin(sessionId: string, pinId: string): Promise<boolean>;

  visibleEntries(sessionId: string, principalId: string): Promise<SessionEntry[]>;

  searchEntries(principalId: string, query: string, limit?: number): Promise<EntrySearchHit[]>;

  appendSearchEntries(lease: Lease, rows: readonly NewSearchEntry[]): Promise<void>;
  searchIndexCoverage(sessionId: string): Promise<number>;
  missingSearchEntries(sessionId: string): Promise<number>;
  lastSearchableEntrySeq(sessionId: string): Promise<number>;

  scanAll(): Promise<Session[]>;

  countSessions(): Promise<number>;

  listByScope(scope: ScopeId): Promise<Session[]>;

  scopeHasSessions(scope: ScopeId): Promise<boolean>;

  sessionsByThreadRefs(threadRefs: readonly string[]): Promise<SessionRef[]>;

  distinctScopes(): Promise<DistinctScope[]>;

  scopeSessionSummaries(
    scope: ScopeId,
    orgWide: boolean,
    page?: SessionPage,
    sessionIds?: string[],
  ): Promise<SessionSummary[]>;

  lastUserMessages(sessionIds: string[]): Promise<Map<string, string>>;

  scopeCronGroups(scope: ScopeId, orgWide: boolean): Promise<CronGroupSummary[]>;

  scopeSessionRollups(scope: ScopeId, orgWide: boolean): Promise<ScopeSessionRollup[]>;

  scopeSessionStats(
    scope: ScopeId,
    orgWide: boolean,
    category?: SessionCategory,
    origin?: SessionOriginFilter,
    cronId?: string,
  ): Promise<ScopeSessionStats>;

  attributedTurns(): Promise<AttributedTurn[]>;

  listParticipants(): Promise<ParticipantWindow[]>;

  distinctParticipants(): Promise<string[]>;

  participantWindowsOf(sessionId: string): Promise<ParticipantWindow[]>;

  participantsOf(sessionId: string): Promise<string[]>;
}
