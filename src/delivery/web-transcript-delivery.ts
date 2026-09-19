import { DurableTaskDeferred } from "../durable/tasks.ts";
import type { SessionEntry } from "../types.ts";
import {
  appendEntryOutsideTurn,
  entryDeliveryKey,
  type SessionStore,
  type TranscriptAppendSessions,
} from "../sessions/session-store.ts";
import { messageTag } from "../util/message-tag.ts";
import type { DeliveryHandler } from "./task-delivery.ts";

type WebTranscriptSessions = TranscriptAppendSessions &
  Pick<SessionStore, "getByThread" | "acquireLease" | "releaseLease" | "getEntries">;

export function createWebDeliveryHandler(
  sessions: WebTranscriptSessions & Pick<SessionStore, "findEntryByDeliveryKey">,
  onRecorded?: (sessionId: string, threadRef: string) => void | Promise<void>,
): DeliveryHandler {
  return async (delivery, context) => {
    const sessionId = await context.step("web:transcript", async () => {
      const session = await sessions.getByThread(delivery.destination.target);
      if (!session) throw new Error(`Web delivery ${delivery.id} has no destination session`);
      const { lease } = await sessions.acquireLease(session.id, "backfill");
      if (!lease) throw new DurableTaskDeferred(1);
      try {
        const key = delivery.idempotencyKey;
        const ownReply = delivery.provenance?.sourceThreadRef === delivery.destination.target;
        const existingReply = ownReply && delivery.provenance?.sourceAssistantEntrySeq !== undefined;
        const failure =
          delivery.destination.webTranscript?.kind === "turn_failure" ? delivery.destination.webTranscript : undefined;
        if (
          delivery.text.trim() &&
          !existingReply &&
          !(await sessions.findEntryByDeliveryKey(session.id, key)) &&
          !(failure && turnRecordedFailure(await sessions.getEntries(session.id), failure))
        ) {
          const via = ownReply ? undefined : delivery.provenance?.trigger;
          await appendEntryOutsideTurn(
            sessions,
            lease,
            {
              type: failure ? "system" : "assistant",
              payload: failure
                ? {
                    kind: "turn_failure",
                    message: delivery.text,
                    deliveryKey: key,
                    ...(failure.runId ? { runId: failure.runId } : {}),
                  }
                : { text: delivery.text, deliveryKey: key, ...(via ? { via } : {}) },
              scopeLabel: session.scopeId,
            },
            failure
              ? undefined
              : (appended) =>
                  messageTag(
                    { from: "agent", ...(via ? { via } : {}), sentAt: new Date(appended.createdAt).toISOString() },
                    delivery.text,
                  ),
          );
        }
        if (delivery.attachments?.length && !(await sessions.findEntryByDeliveryKey(session.id, `${key}:files`))) {
          await appendEntryOutsideTurn(sessions, lease, {
            type: "delivery",
            payload: {
              deliveryKey: `${key}:files`,
              files: delivery.attachments.map(({ name, mimetype, sizeBytes, artifactId }) => ({
                name,
                mimetype,
                sizeBytes,
                ...(artifactId ? { artifactId } : {}),
              })),
              ...(existingReply ? { sourceAssistantEntrySeq: delivery.provenance!.sourceAssistantEntrySeq } : {}),
            },
            scopeLabel: session.scopeId,
          });
        }
        return session.id;
      } finally {
        await sessions.releaseLease(lease);
      }
    });
    await onRecorded?.(sessionId, delivery.destination.target);
  };
}

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
