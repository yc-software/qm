import type { Delivery, ScopeId } from "../types.ts";
import { isReply, isUserMessage, type Item, type NewItem } from "../sessions/items.ts";
import { turnFailureItem } from "../core/turn-error.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { reportFailure, swallow } from "../util/errors.ts";

const DEDUPE_SCAN_LIMIT = 200;
const RECORDED_CACHE_CAP = 1000;
const WRITE_GIVEUP_MS = 10 * 60_000;

type WebTranscriptSessions = Pick<
  SessionStore,
  "appendMany" | "hasDeliveryEntry" | "get" | "getByThread" | "acquireLease" | "releaseLease" | "getItems"
>;

export function turnRecordedFailure(tail: readonly Item[], note: { notBefore: number; runId?: string }): boolean {
  return tail.some((item) => {
    if (item.kind !== "Error") return false;
    if (item.turnId !== null) return item.turnId === note.runId;
    return item.createdAt >= note.notBefore;
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
  const overdue = (d: Delivery): boolean =>
    d.destination.webTranscript?.kind !== "slack_reply" && Date.now() - d.createdAt > WRITE_GIVEUP_MS;

  const appendTranscriptEntry = async (d: Delivery, session: { id: string; scopeId: ScopeId }): Promise<boolean> => {
    const { lease } = await sessions.acquireLease(session.id, "backfill");
    if (!lease) return false;
    try {
      const note = d.destination.webTranscript;
      const reply = note?.kind === "slack_reply" ? note : undefined;
      if (await sessions.hasDeliveryEntry(session.id, d.idempotencyKey, reply?.ts)) return true;
      const failure = note?.kind === "turn_failure" ? note : undefined;
      if (failure && turnRecordedFailure(await sessions.getItems(session.id, { limit: DEDUPE_SCAN_LIMIT }), failure))
        return true;
      const turnId = failure?.runId ?? d.id;
      if (
        !failure &&
        (await sessions.getItems(session.id, { turnId })).some((item) => (reply ? isUserMessage(item) : isReply(item)))
      )
        return true;
      const ownReply = d.provenance?.sourceThreadRef === d.destination.target;
      const via = d.provenance?.trigger && !ownReply ? d.provenance.trigger : undefined;
      let entry: NewItem;
      if (reply) {
        entry = {
          kind: "UserMessage",
          text: d.text,
          externalId: reply.ts,
          body: { name: reply.name, slackReplyReceipt: true, deliveryKey: d.idempotencyKey },
        };
      } else if (failure) {
        entry = turnFailureItem(d.text, failure.runId);
      } else {
        entry = { kind: "AgentMessage", text: d.text, body: via ? { via } : {} };
      }
      await sessions.appendMany({ ...lease, turnId }, [entry]);
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
    const note = d.destination.webTranscript;
    const session =
      note?.kind === "slack_reply"
        ? await sessions.get(note.sessionId)
        : await sessions.getByThread(d.destination.target);
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
          reportFailure(
            "web delivery: transcript write gave up (delivering as a nudge only)",
            err,
            `delivery=${d.idempotencyKey} target=${d.destination.target} after=${WRITE_GIVEUP_MS}ms`,
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
    async enqueue(input) {
      const delivery = await store.enqueue(input);
      if (delivery.destination.webTranscript?.kind === "slack_reply") {
        try {
          await recordedForDelivery(delivery);
        } catch (error) {
          swallow("slack reply transcript write (will retry)", error);
        }
      }
      return delivery;
    },
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
