import type { Delivery, ScopeId } from "../types.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { hasRunningRun, type RunStore } from "../runs/run-store.ts";
import { type Item, type NewItem } from "../sessions/items.ts";
import { turnFailureItem } from "../core/turn-error.ts";
import { reportFailure, swallow } from "../util/errors.ts";
import { withTenant } from "../tenants/context.ts";
import { claimThenBind } from "../tenants/claim.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";

const DEDUPE_SCAN_LIMIT = 200;
const RECORDED_CACHE_CAP = 1000;
const WRITE_GIVEUP_MS = 10 * 60_000;

type WebTranscriptSessions = Pick<
  SessionStore,
  "appendDelivery" | "get" | "getByThread" | "getItems" | "participantsOf"
>;

export function turnRecordedFailure(tail: readonly Item[], note: { notBefore: number; runId?: string }): boolean {
  return tail.some((item) => {
    if (item.kind !== "Error" || item.errorCode !== "turn_failure") return false;
    if (item.turnId !== null) return item.turnId === note.runId;
    return item.createdAt >= note.notBefore;
  });
}

type Disposition = "deliver" | "record" | "settle";

function classify(d: Delivery): Disposition {
  if (d.destination.type === "webhook") {
    const recorded =
      d.provenance?.sourceThreadRef === d.destination.target && d.provenance.sourceAssistantEntrySeq !== undefined;
    return d.text.trim() && !recorded ? "record" : "deliver";
  }
  if (d.destination.type !== "web") return "deliver";
  if (d.destination.webTranscript && d.text.trim()) return "record";
  if (!d.provenance) return "deliver";
  if (d.provenance.sourceThreadRef !== d.destination.target) return d.text.trim() ? "record" : "deliver";
  if (d.provenance.sourceAssistantEntrySeq === undefined || d.attachments?.length) return "deliver";
  return "settle";
}

const transcribed = (type: string): boolean => type === "web" || type === "webhook";

export function withWebTranscriptDeliveries(
  store: DeliveryStore,
  sessions: WebTranscriptSessions,
  runs: Pick<RunStore, "inFlightForThread">,
  states?: Pick<SessionStateBus, "emit">,
): DeliveryStore & { transcribeUndelivered(type: string): Promise<void> } {
  const recorded = new Set<string>();
  const remember = (key: string): void => {
    if (recorded.size >= RECORDED_CACHE_CAP) recorded.clear();
    recorded.add(key);
  };
  const overdue = (d: Delivery): boolean =>
    d.destination.webTranscript?.kind !== "slack_reply" && Date.now() - d.createdAt > WRITE_GIVEUP_MS;

  const appendTranscriptEntry = async (
    d: Delivery,
    session: { id: string; scopeId: ScopeId; threadRef: string },
  ): Promise<boolean> => {
    if (await hasRunningRun(runs, session.threadRef)) return false;
    const note = d.destination.webTranscript;
    const reply = note?.kind === "slack_reply" ? note : undefined;
    const failure = note?.kind === "turn_failure" ? note : undefined;
    if (failure && turnRecordedFailure(await sessions.getItems(session.id, { limit: DEDUPE_SCAN_LIMIT }), failure))
      return true;
    const turnId = failure?.runId ?? d.id;
    const ownReply = d.provenance?.sourceThreadRef === d.destination.target;
    const via = d.provenance?.trigger && !ownReply ? d.provenance.trigger : undefined;
    let item: NewItem;
    if (reply) {
      item = {
        kind: "UserMessage",
        text: d.text,
        externalId: reply.ts,
        body: { name: reply.name, slackReplyReceipt: true, deliveryKey: d.idempotencyKey },
      };
    } else if (failure) {
      item = turnFailureItem(d.text, failure.runId);
    } else {
      item = { kind: "AgentMessage", text: d.text, body: via ? { via } : {} };
    }
    const inserted = await sessions.appendDelivery({ sessionId: session.id, turnId }, item, d.idempotencyKey);
    if (!inserted) return true;
    if (states) {
      const participants = await sessions.participantsOf(session.id);
      states.emit({
        threadRef: session.threadRef,
        sessionId: session.id,
        state: "idle",
        at: Date.now(),
        ...(participants.length ? { participants } : {}),
      });
    }
    return true;
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

  const drained = async <D extends Delivery>(rows: D[]): Promise<D[]> => {
    const out: D[] = [];
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
    async pending(type, sourceThreadRef) {
      const rows = await store.pending(type, sourceThreadRef);
      return transcribed(type) ? drained(rows) : rows;
    },
    async claimPending(type, ttlMs) {
      const rows = await store.claimPending(type, ttlMs);
      return transcribed(type) ? drained(rows) : rows;
    },
    async transcribeUndelivered(type) {
      await claimThenBind(
        () => store.undeliveredTenants(type),
        async () => drained(await store.pending(type)),
      );
    },
    async claimDue(type, ttlMs) {
      const rows = await store.claimDue(type, ttlMs);
      if (!transcribed(type)) return rows;
      const out: typeof rows = [];
      for (const d of rows) out.push(...(await withTenant(d.tenantId, () => drained([d]))));
      return out;
    },
  };
}
