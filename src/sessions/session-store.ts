import type { EntryType, ScopeId, Session, SessionEntry, SessionType } from "../types.ts";

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

type TapeKind = "message" | "context_event" | "annotation";

interface TapeMeta {
  bareText?: string;
  ts?: string;
  changeTime?: string;
  hidden?: boolean;
  overheard?: boolean;
  author?: string;
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
  truncated: boolean;
  ttftMs: number | null;
  durationMs: number | null;
  stepGapMs: number | null;
  toolWallMs: number[] | null;
  gapPhases: GapPhases | null;
  usage: LlmCallUsage | null;
  transport: LlmTransportMeta | null;
}

export interface NewLlmRequest {
  turnSeq: number | null;
  step: number;
  model: string;
  scopeLabel: ScopeId;
  request: unknown;
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
export const STABLE_CRON_ID_PATTERN = "^agent:main:cron:([^:]+)$";
export const LEGACY_CRON_ID_PATTERN = "^cron:([^:]+)(:.+)?$";

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

export function windowedTranscript(
  entries: SessionEntry[],
  window?: { tailTurns?: number; sinceSeq?: number; beforeSeq?: number },
): { entries: SessionEntry[]; earlier: number } {
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
  return { entries: cut > 0 ? entries.slice(cut) : entries, earlier: cut };
}

export function isOverheardEntry(e: Pick<SessionEntry, "type" | "payload">): boolean {
  return e.type === "user" && (e.payload as { overheard?: unknown } | null)?.overheard === true;
}

interface AddParticipantOptions {
  includeHistory?: boolean;
}

export interface SessionStore {
  health?(): Promise<void>;
  close?(): Promise<void>;

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

  acquireLease(sessionId: string, holder?: LeaseHolder): Promise<LeaseAttempt>;
  releaseLease(lease: Lease): Promise<void>;
  forceReleaseLease(sessionId: string): Promise<void>;

  append(lease: Lease, entry: NewEntry): Promise<SessionEntry>;
  getEntries(sessionId: string, opts?: GetEntriesOptions): Promise<SessionEntry[]>;

  appendTape(lease: Lease, rec: NewTapeRecord): Promise<TapeRecord>;
  getTape(sessionId: string, opts?: GetTapeOptions): Promise<TapeRecord[]>;
  tapeCoverage(sessionId: string): Promise<number>;

  recordLlmRequest(sessionId: string, rec: NewLlmRequest): Promise<LlmRequestRecord>;
  listLlmRequests(sessionId: string, opts?: ListLlmRequestsOptions): Promise<LlmRequestRecord[]>;

  addParticipant(sessionId: string, principalId: string, title?: string, opts?: AddParticipantOptions): Promise<void>;
  removeParticipant(sessionId: string, principalId: string): Promise<void>;
  listByParticipant(principalId: string): Promise<Session[]>;

  deleteSession(sessionId: string): Promise<void>;

  updateParticipantView(sessionId: string, principalId: string, patch: ParticipantViewPatch): Promise<void>;

  visibleEntries(sessionId: string, principalId: string): Promise<SessionEntry[]>;

  listAll(): Promise<Session[]>;

  sessionsByThreadRefs(threadRefs: readonly string[]): Promise<SessionRef[]>;

  distinctScopes(): Promise<DistinctScope[]>;

  scopeSessionSummaries(
    scope: ScopeId,
    orgWide: boolean,
    page?: SessionPage,
    includePreviews?: boolean,
    sessionIds?: string[],
  ): Promise<SessionSummary[]>;

  lastUserMessages(sessionIds: string[]): Promise<Map<string, string>>;

  scopeCronGroups(scope: ScopeId, orgWide: boolean): Promise<CronGroupSummary[]>;

  scopeSessionStats(
    scope: ScopeId,
    orgWide: boolean,
    category?: SessionCategory,
    origin?: SessionOriginFilter,
    cronId?: string,
  ): Promise<ScopeSessionStats>;

  attributedTurns(): Promise<AttributedTurn[]>;

  listParticipants(): Promise<ParticipantWindow[]>;

  participantsOf(sessionId: string): Promise<string[]>;
}
