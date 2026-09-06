import type { Delivery, ScopeId, SessionEntry } from "../types.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import {
  appendEntryOutsideTurn,
  entryDeliveryKey,
  type SessionStore,
  type TranscriptAppendSessions,
} from "../sessions/session-store.ts";
import { messageTag } from "../util/message-tag.ts";
import { errMessage, swallow } from "../util/errors.ts";

const DEDUPE_SCAN_LIMIT = 200;
const RECORDED_CACHE_CAP = 1000;
const WRITE_GIVEUP_MS = 10 * 60_000;

type WebTranscriptSessions = TranscriptAppendSessions &
  Pick<SessionStore, "getByThread" | "acquireLease" | "releaseLease" | "getEntries">;

export function turnRecordedFailure(
  tail: readonly SessionEntry[],
  note: { notBefore: number; runId?: string },
): boolean {
  return tail.some((entry) => {
    if (entry.type !== "system") return false;
    const payload = entry.payload as { kind?: unknown; runId?: unknown } | null;
    if (payload?.kind !== "turn_failure") return false;
    if (typeof payload.runId === "string") return payload.runId === note.runId;
    return entryDeliveryKey(entry) === undefined && entry.createdAt >= note.notBefore;
  });
}

type Disposition = "deliver" | "record" | "settle";

function classify(d: Delivery): Disposition {
  if (d.destination.type !== "web") return "deliver";
  if (d.destination.webTranscript && d.text.trim()) return "record";
  if (!d.provenance) return "deliver";
  if (d.provenance.sourceThreadRef !== d.destination.target) return d.text.trim() ? "record" : "deliver";
  if (d.provenance.sourceAssistantEntrySeq === undefined || d.attachments?.length) return "deliver";
  return "settle";
}

export function withWebTranscriptDeliveries(store: DeliveryStore, sessions: WebTranscriptSessions): DeliveryStore {
  const recorded = new Set<string>();
  const remember = (key: string): void => {
    if (recorded.size >= RECORDED_CACHE_CAP) recorded.clear();
    recorded.add(key);
  };
  const overdue = (d: Delivery): boolean => Date.now() - d.createdAt > WRITE_GIVEUP_MS;

  const appendTranscriptEntry = async (d: Delivery, session: { id: string; scopeId: ScopeId }): Promise<boolean> => {
    const { lease } = await sessions.acquireLease(session.id, "backfill");
    if (!lease) return false;
    try {
      const tail = await sessions.getEntries(session.id, { limit: DEDUPE_SCAN_LIMIT });
      if (tail.some((entry) => entryDeliveryKey(entry) === d.idempotencyKey)) return true;
      const note = d.destination.webTranscript;
      const failure = note?.kind === "turn_failure" ? note : undefined;
      if (failure && turnRecordedFailure(tail, failure)) return true;
      const scopeLabel = session.scopeId;
      const ownReply = d.provenance?.sourceThreadRef === d.destination.target;
      const via = d.provenance?.trigger && !ownReply ? d.provenance.trigger : undefined;
      const entry = failure
        ? {
            type: "system" as const,
            payload: {
              kind: "turn_failure",
              message: d.text,
              deliveryKey: d.idempotencyKey,
              ...(failure.runId ? { runId: failure.runId } : {}),
            },
          }
        : {
            type: "assistant" as const,
            payload: { text: d.text, deliveryKey: d.idempotencyKey, ...(via ? { via } : {}) },
          };
      await appendEntryOutsideTurn(
        sessions,
        lease,
        { ...entry, scopeLabel },
        failure
          ? undefined
          : (appended) =>
              messageTag(
                { from: "agent", ...(via ? { via } : {}), sentAt: new Date(appended.createdAt).toISOString() },
                d.text,
              ),
      );
      return true;
    } finally {
      await sessions.releaseLease(lease);
    }
  };

  const recordedForDelivery = async (d: Delivery): Promise<boolean> => {
    if (recorded.has(d.idempotencyKey)) return true;
    if (overdue(d)) {
      console.error(
        `[delivery] web delivery ${d.idempotencyKey} was not recorded in ${d.destination.target} within ${WRITE_GIVEUP_MS}ms — delivering as a nudge only`,
      );
      remember(d.idempotencyKey);
      return true;
    }
    const session = await sessions.getByThread(d.destination.target);
    if (!session) {
      console.error(
        `[delivery] web delivery ${d.idempotencyKey} targets ${d.destination.target}, which has no session — delivering as a nudge only`,
      );
      remember(d.idempotencyKey);
      return true;
    }
    if (await appendTranscriptEntry(d, session)) {
      remember(d.idempotencyKey);
      return true;
    }
    return false;
  };

  const drained = async (rows: Delivery[]): Promise<Delivery[]> => {
    const out: Delivery[] = [];
    for (const d of rows) {
      try {
        const disposition = classify(d);
        if (disposition === "settle") {
          await store.ack(d.id, Date.now());
          continue;
        }
        if (disposition === "deliver" || (await recordedForDelivery(d))) out.push(d);
      } catch (err) {
        if (overdue(d)) {
          console.error(
            `[delivery] web delivery ${d.idempotencyKey} could not be recorded in ${d.destination.target}'s transcript within ${WRITE_GIVEUP_MS}ms — delivering as a nudge only:`,
            errMessage(err),
          );
          remember(d.idempotencyKey);
          out.push(d);
        } else {
          swallow(`web delivery ${d.idempotencyKey} transcript write (will retry)`, err);
        }
      }
    }
    return out;
  };

  return {
    ...store,
    async pending(type) {
      const rows = await store.pending(type);
      return type === "web" ? drained(rows) : rows;
    },
    async claimPending(type, ttlMs) {
      const rows = await store.claimPending(type, ttlMs);
      return type === "web" ? drained(rows) : rows;
    },
  };
}
