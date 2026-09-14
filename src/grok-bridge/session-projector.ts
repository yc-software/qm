import {
  acquireLeaseWithin,
  appendEntryOutsideTurn,
  entryDeliveryKey,
  type SessionStore,
} from "../sessions/session-store.ts";
import { swallow } from "../util/errors.ts";
import type { ProjectorPort } from "./types.ts";

const PROJECT_LEASE_MS = 2_000;
const DEDUPE_SCAN_LIMIT = 200;

export function createSessionProjector(
  sessions: Pick<
    SessionStore,
    | "get"
    | "acquireLease"
    | "peekLease"
    | "releaseLease"
    | "getEntries"
    | "append"
    | "appendTape"
    | "latestEntrySeq"
    | "tapeCoverage"
  >,
): ProjectorPort {
  return {
    async project(job, pairing, event) {
      const session = await sessions.get(job.originSessionId);
      if (!session) return;
      const deliveryKey = `grok-bridge:${job.id}:${event.seq}`;
      try {
        const { lease } = await acquireLeaseWithin(sessions, session.id, "backfill", PROJECT_LEASE_MS);
        if (!lease) return;
        try {
          const tail = await sessions.getEntries(session.id, { limit: DEDUPE_SCAN_LIMIT });
          if (tail.some((entry) => entryDeliveryKey(entry) === deliveryKey)) return;
          const via = `${pairing.ownerPrincipalId}'s Grok Bot`;
          await appendEntryOutsideTurn(sessions, lease, {
            type: "assistant",
            scopeLabel: session.scopeId,
            payload: {
              text: `${pairing.agentName} · via ${via}\n\n${event.summary}`,
              deliveryKey,
              via,
              grokBridge: { jobId: job.id, seq: event.seq, status: event.status },
            },
          });
        } finally {
          await sessions.releaseLease(lease);
        }
      } catch (error) {
        swallow("grok-bridge: session projection", error);
      }
    },
  };
}
