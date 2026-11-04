import type { SessionStore, SessionWriter } from "../sessions/session-store.ts";
import { hasRunningRun, type RunStore } from "../runs/run-store.ts";
import { parseSlackThreadRef, slackThreadRefCandidates } from "./message-gating.ts";
import type { IngestEvent, SurfaceCache } from "../surface-cache/types.ts";
import { isoFromTs, xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import { sleep } from "../util/async.ts";
import { isAgentReply, isHidden, isUserItem, type Item, messageTs } from "../sessions/items.ts";

export interface MessageRevisionPayload {
  action: "edited" | "deleted";
  /** Slack message ts of the revised message. Absent for web edits, which name the message by `seq`. */
  ts?: string;
  /** Transcript seq of the revised web UserMessage. */
  seq?: number;
  /** ISO send time of a web message (Slack derives it from `ts`). */
  sentAt?: string;
  /** Excerpt of the web message's text before this edit, so the model can tell which message changed. */
  original?: string;
  text?: string;
  name?: string;
  sourceRole?: "agent";
}

const WEB_EDIT_ORIGINAL_MAX_CHARS = 300;

interface MessageRevisionSource {
  self?: boolean;
  ts: string;
  deleted?: boolean;
  text?: string;
}

export type RevisionSessions = Pick<SessionStore, "append" | "sessionsByThreadRefs" | "getItems">;

export type RevisionRuns = Pick<RunStore, "inFlightForThread">;

interface RevisionSession {
  id: string;
}

export function messageRevision(e: Pick<Item, "kind" | "body">): MessageRevisionPayload | null {
  if (e.kind !== "Retraction") return null;
  const p = e.body;
  if (p.action !== "edited" && p.action !== "deleted") return null;
  const hasTs = typeof p.ts === "string" && p.ts !== "";
  const hasSeq = typeof p.seq === "number" && Number.isInteger(p.seq) && p.seq >= 0;
  if (!hasTs && !hasSeq) return null;
  return p as unknown as MessageRevisionPayload;
}

export function renderMessageRevision(p: MessageRevisionPayload): string {
  const sentAt = p.ts ? isoFromTs(p.ts) : (p.sentAt ?? "");
  const attrs = [
    ...(p.ts ? [`id="${xmlAttrEscape(p.ts)}"`] : []),
    ...(p.sourceRole ? [`from="${p.sourceRole}"`] : []),
    ...(p.name?.trim() ? [`author="${xmlAttrEscape(p.name.trim())}"`] : []),
    ...(sentAt ? [`sent-at="${sentAt}"`] : []),
    ...(p.original ? [`original="${xmlAttrEscape(p.original)}"`] : []),
  ].join(" ");
  return p.action === "deleted"
    ? `<message-deleted ${attrs}>the author deleted this message</message-deleted>`
    : `<message-edited ${attrs}>${xmlEscape(p.text ?? "")}</message-edited>`;
}

export type WebEditRefusal = "not_editable" | "empty_text";

/**
 * Revision record for a person editing their own web message (a UserMessage named by transcript seq).
 * Returns null when the text is unchanged since the last edit.
 */
export function webMessageEdit(
  items: readonly Item[],
  seq: number,
  editor: (author: string | null) => boolean,
  text: string,
): MessageRevisionPayload | null | WebEditRefusal {
  const original = items.find((e) => e.seq === seq);
  if (!original || original.kind !== "UserMessage" || isHidden(original) || !editor(original.author))
    return "not_editable";
  if (!text.trim()) return "empty_text";
  const display =
    typeof original.body.display === "string" && original.body.display.trim() ? original.body.display : null;
  const originalText = display ?? original.text ?? "";
  let effective = originalText;
  for (const e of items) {
    const r = messageRevision(e);
    if (r?.seq === seq && r.action === "edited") effective = r.text ?? effective;
  }
  if (text === effective) return null;
  const { name } = original.body;
  const flat = originalText.trim().replace(/\s+/g, " ");
  return {
    action: "edited",
    seq,
    sentAt: new Date(original.createdAt).toISOString(),
    original: flat.length > WEB_EDIT_ORIGINAL_MAX_CHARS ? `${flat.slice(0, WEB_EDIT_ORIGINAL_MAX_CHARS)}…` : flat,
    text,
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
  };
}

function isRevisionEvent(e: IngestEvent): boolean {
  return Boolean(e.ts) && (e.deleted === true || e.editedAt !== undefined);
}

export function hasRevisionEvents(events: readonly IngestEvent[]): boolean {
  return events.some(isRevisionEvent);
}

interface OriginalMessage {
  text: string;
  name?: string;
  sourceRole?: "agent";
}

function findOriginal(items: readonly Item[], ts: string): OriginalMessage | null {
  let found: OriginalMessage | null = null;
  for (const e of items) {
    if (!isUserItem(e) || messageTs(e) !== ts) continue;
    if (isHidden(e)) return null;
    const { name, sourceRole } = e.body;
    found = {
      text: e.text ?? "",
      ...(sourceRole === "agent" ? { sourceRole: "agent" as const } : {}),
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    };
  }
  return found;
}

function revisionToRecord(entries: readonly Item[], source: MessageRevisionSource): MessageRevisionPayload | null {
  const original = findOriginal(entries, source.ts);
  if (!original || (source.self && original.sourceRole !== "agent")) return null;
  let last: MessageRevisionPayload | null = null;
  for (const e of entries) {
    const r = messageRevision(e);
    if (r && r.ts === source.ts) last = r;
  }
  const named = {
    ...(original.name ? { name: original.name } : {}),
    ...(original.sourceRole ? { sourceRole: original.sourceRole } : {}),
  };
  if (source.deleted) {
    if (last?.action === "deleted") return null;
    return { action: "deleted", ts: source.ts, ...named };
  }
  const text = String(source.text ?? "");
  const effective = last?.action === "deleted" ? null : (last?.text ?? original.text);
  if (!text.trim() || text === effective) return null;
  return { action: "edited", ts: source.ts, text, ...named };
}

async function recordRevision(
  sessions: Pick<SessionStore, "append">,
  writer: SessionWriter,
  items: readonly Item[],
  source: MessageRevisionSource,
): Promise<boolean> {
  const revision = revisionToRecord(items, source);
  if (!revision) return false;
  await sessions.append(writer, { kind: "Retraction", body: { ...revision } });
  return true;
}

export interface IdleRetry {
  attempts: number;
  retryMs: number;
}

const DEFAULT_IDLE_RETRY: IdleRetry = { attempts: 4, retryMs: 3_000 };

async function recordWhenIdle(
  sessions: RevisionSessions,
  runs: RevisionRuns,
  session: RevisionSession & { threadRef: string },
  source: MessageRevisionSource,
  retry: IdleRetry,
): Promise<void> {
  if (!revisionToRecord(await sessions.getItems(session.id), source)) return;
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    if (attempt > 0) await sleep(retry.retryMs, { unref: true });
    if (await hasRunningRun(runs, session.threadRef)) continue;
    await recordRevision(sessions, { sessionId: session.id }, await sessions.getItems(session.id), source);
    return;
  }
}

export async function recordMessageRevisions(
  sessions: RevisionSessions,
  runs: RevisionRuns,
  events: readonly IngestEvent[],
  retry: IdleRetry = DEFAULT_IDLE_RETRY,
): Promise<void> {
  for (const event of events.filter(isRevisionEvent)) {
    const refs = await sessions.sessionsByThreadRefs(
      slackThreadRefCandidates(event.container, event.ts, event.sub ?? undefined),
    );
    for (const ref of refs) await recordWhenIdle(sessions, runs, ref, event, retry);
  }
}

const ANCHOR_WALK_BACK = 8;

export async function revisionAnchorAt(
  sessions: Pick<SessionStore, "latestItemSeq" | "getItem">,
  sessionId: string,
): Promise<number | undefined> {
  let seq = await sessions.latestItemSeq(sessionId);
  for (let steps = 0; seq >= 0 && steps < ANCHOR_WALK_BACK; steps++, seq--) {
    const item = await sessions.getItem(sessionId, seq);
    if (!item) return undefined;
    if (isUserItem(item) || isAgentReply(item)) return item.createdAt;
  }
  return undefined;
}

export function slackTsToMs(ts: string | undefined): number | undefined {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : undefined;
}

export async function reconcileMessageRevisions(opts: {
  sessions: Pick<SessionStore, "append" | "getItems">;
  surfaceCache: Pick<SurfaceCache, "revisedSince">;
  writer: SessionWriter;
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
  const items = await opts.sessions.getItems(opts.session.id);
  let recorded = 0;
  for (const row of revised) {
    if (await recordRevision(opts.sessions, opts.writer, items, row)) recorded++;
  }
  return recorded;
}
