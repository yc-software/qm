import type { ScopeId, SessionEntry } from "../types.ts";
import {
  appendEntryOutsideTurn,
  type Lease,
  type SessionStore,
  type TranscriptAppendSessions,
} from "../sessions/session-store.ts";
import { parseSlackThreadRef, slackThreadRefCandidates } from "../slack/message-gating.ts";
import type { IngestEvent, SurfaceCache } from "../surface-cache/types.ts";
import { isoFromTs, xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import { sleep } from "../util/async.ts";

export interface MessageRevisionPayload {
  kind: "message_revision";
  action: "edited" | "deleted";
  ts: string;
  text?: string;
  name?: string;
}

interface MessageRevisionSource {
  ts: string;
  deleted?: boolean;
  text?: string;
}

export type RevisionSessions = TranscriptAppendSessions &
  Pick<SessionStore, "sessionsByThreadRefs" | "acquireLease" | "releaseLease" | "getEntries">;

interface RevisionSession {
  id: string;
  scopeId: ScopeId;
}

export function messageRevision(e: Pick<SessionEntry, "type" | "payload">): MessageRevisionPayload | null {
  if (e.type !== "system") return null;
  const p = e.payload as { kind?: unknown; action?: unknown; ts?: unknown } | null;
  if (p?.kind !== "message_revision") return null;
  if (p.action !== "edited" && p.action !== "deleted") return null;
  if (typeof p.ts !== "string" || !p.ts) return null;
  return p as unknown as MessageRevisionPayload;
}

export function renderMessageRevision(p: MessageRevisionPayload): string {
  const attrs = [
    `id="${xmlAttrEscape(p.ts)}"`,
    ...(p.name?.trim() ? [`author="${xmlAttrEscape(p.name.trim())}"`] : []),
    ...(isoFromTs(p.ts) ? [`sent-at="${isoFromTs(p.ts)}"`] : []),
  ].join(" ");
  return p.action === "deleted"
    ? `<message-deleted ${attrs}>the author deleted this message</message-deleted>`
    : `<message-edited ${attrs}>${xmlEscape(p.text ?? "")}</message-edited>`;
}

function isRevisionEvent(e: IngestEvent): boolean {
  return !e.self && Boolean(e.ts) && (e.deleted === true || e.editedAt !== undefined);
}

export function hasRevisionEvents(events: readonly IngestEvent[]): boolean {
  return events.some(isRevisionEvent);
}

interface OriginalMessage {
  text: string;
  name?: string;
}

function findOriginal(entries: readonly SessionEntry[], ts: string): OriginalMessage | null {
  let found: OriginalMessage | null = null;
  for (const e of entries) {
    if (e.type !== "user") continue;
    const p = e.payload as {
      ts?: unknown;
      text?: unknown;
      name?: unknown;
      hidden?: unknown;
      securityTainted?: unknown;
    } | null;
    if (p?.ts !== ts) continue;
    if (p.hidden === true || p.securityTainted === true) return null;
    found = {
      text: typeof p.text === "string" ? p.text : "",
      ...(typeof p.name === "string" && p.name.trim() ? { name: p.name.trim() } : {}),
    };
  }
  return found;
}

function revisionToRecord(
  entries: readonly SessionEntry[],
  source: MessageRevisionSource,
): MessageRevisionPayload | null {
  const original = findOriginal(entries, source.ts);
  if (!original) return null;
  let last: MessageRevisionPayload | null = null;
  for (const e of entries) {
    const r = messageRevision(e);
    if (r && r.ts === source.ts) last = r;
  }
  const named = original.name ? { name: original.name } : {};
  if (source.deleted) {
    if (last?.action === "deleted") return null;
    return { kind: "message_revision", action: "deleted", ts: source.ts, ...named };
  }
  const text = String(source.text ?? "");
  const effective = last?.action === "deleted" ? null : (last?.text ?? original.text);
  if (!text.trim() || text === effective) return null;
  return { kind: "message_revision", action: "edited", ts: source.ts, text, ...named };
}

async function recordRevision(
  sessions: TranscriptAppendSessions,
  lease: Lease,
  session: RevisionSession,
  entries: readonly SessionEntry[],
  source: MessageRevisionSource,
): Promise<boolean> {
  const payload = revisionToRecord(entries, source);
  if (!payload) return false;
  await appendEntryOutsideTurn(sessions, lease, { type: "system", payload, scopeLabel: session.scopeId }, () =>
    renderMessageRevision(payload),
  );
  return true;
}

export interface IdleRetry {
  attempts: number;
  retryMs: number;
}

const DEFAULT_IDLE_RETRY: IdleRetry = { attempts: 4, retryMs: 3_000 };

async function recordWhenIdle(
  sessions: RevisionSessions,
  session: RevisionSession,
  source: MessageRevisionSource,
  retry: IdleRetry,
): Promise<void> {
  if (!revisionToRecord(await sessions.getEntries(session.id), source)) return;
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    if (attempt > 0) await sleep(retry.retryMs, { unref: true });
    const { lease } = await sessions.acquireLease(session.id, "backfill");
    if (!lease) continue;
    try {
      await recordRevision(sessions, lease, session, await sessions.getEntries(session.id), source);
      return;
    } finally {
      await sessions.releaseLease(lease);
    }
  }
}

export async function recordMessageRevisions(
  sessions: RevisionSessions,
  events: readonly IngestEvent[],
  retry: IdleRetry = DEFAULT_IDLE_RETRY,
): Promise<void> {
  for (const event of events.filter(isRevisionEvent)) {
    const refs = await sessions.sessionsByThreadRefs(slackThreadRefCandidates(event.container, event.ts, event.sub));
    for (const ref of refs) await recordWhenIdle(sessions, ref, event, retry);
  }
}

const ANCHOR_WALK_BACK = 8;

export async function revisionAnchorAt(
  sessions: Pick<SessionStore, "latestEntrySeq" | "getEntry">,
  sessionId: string,
): Promise<number | undefined> {
  let seq = await sessions.latestEntrySeq(sessionId);
  for (let steps = 0; seq >= 0 && steps < ANCHOR_WALK_BACK; steps++, seq--) {
    const entry = await sessions.getEntry(sessionId, seq);
    if (!entry) return undefined;
    if (entry.type === "user" || entry.type === "assistant") return entry.createdAt;
  }
  return undefined;
}

export function slackTsToMs(ts: string | undefined): number | undefined {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : undefined;
}

export async function reconcileMessageRevisions(opts: {
  sessions: TranscriptAppendSessions & Pick<SessionStore, "getEntries">;
  surfaceCache: Pick<SurfaceCache, "revisedSince">;
  lease: Lease;
  session: RevisionSession & { threadRef: string };
  anchorAt: number | undefined;
  fallbackSince: number;
  triggerTs?: string;
}): Promise<number> {
  const ref = parseSlackThreadRef(opts.session.threadRef);
  if (!ref) return 0;
  const since = Math.max(1, Math.min(opts.anchorAt ?? opts.fallbackSince, slackTsToMs(opts.triggerTs) ?? Infinity));
  const revised = await opts.surfaceCache.revisedSince(ref.container, since, ref.root ? { thread: ref.root } : {});
  if (!revised.length) return 0;
  const entries = await opts.sessions.getEntries(opts.session.id);
  let recorded = 0;
  for (const row of revised) {
    if (await recordRevision(opts.sessions, opts.lease, opts.session, entries, row)) recorded++;
  }
  return recorded;
}
