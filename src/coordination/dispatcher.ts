import type { RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { Principal, TurnRequest, TurnResult } from "../types.ts";
import { createPeerDeliveryLedger } from "./delivery.ts";
import type { CoordinationRepository } from "./repository.ts";
import type { Peer, PeerAuthority } from "./types.ts";
import type { PeerIdentity } from "./identity.ts";
import { peerInput } from "./peer-input.ts";

export interface PeerDispatcherDeps {
  repository: CoordinationRepository;
  identity: PeerIdentity;
  runs: RunStore;
  sessions: SessionStore;
  authorize(peer: Peer): Promise<PeerAuthority | null>;
  blocked(sessionId: string): Promise<boolean>;
  enqueue(request: TurnRequest): Promise<TurnResult>;
}

export function createPeerDispatcher(deps: PeerDispatcherDeps) {
  const ledger = createPeerDeliveryLedger(deps.repository);
  const assertion = (principal: Principal) => ({
    externalId: principal.id,
    isExternalGuest: principal.type !== "internal",
  });

  async function dispatch(id: string): Promise<void> {
    const delivery = await ledger.claim(id);
    if (!delivery) return;
    const token = delivery.leaseToken!;
    const settle = (state: "queued" | "delivered" | "blocked" | "failed", reason: string | null = null) =>
      ledger.settle(id, token, state, reason);
    try {
      const [storedPeer, message] = await Promise.all([
        deps.repository.get("peer", delivery.recipientId),
        deps.repository.get("message", delivery.messageId),
      ]);
      const peer =
        storedPeer && !storedPeer.authority
          ? await deps.identity.ensure({ id: storedPeer.id, scopeId: storedPeer.scopeId })
          : storedPeer;
      if (!peer || !message || peer.state === "deleted") {
        await settle("failed", "recipient_unavailable");
        return;
      }
      const session = await deps.sessions.get(peer.id);
      if (
        !session ||
        session.scopeId !== peer.scopeId ||
        !peer.authority ||
        peer.authority.conversation.threadRef !== session.threadRef
      ) {
        await settle("blocked", "execution_authority_unavailable");
        return;
      }
      const previous = delivery.runId ? await deps.runs.get(delivery.runId) : null;
      if (previous?.request.origin?.kind === "peer" && previous.request.origin.deliveryId === id) {
        await settle("delivered");
        return;
      }
      if (peer.state !== "active" || session.archived) {
        await settle("blocked", "recipient_inactive");
        return;
      }
      const authority = await deps.authorize(peer);
      if (!authority) {
        await settle("blocked", "execution_authority_revoked");
        return;
      }
      if (await deps.blocked(peer.id)) {
        await settle("blocked", "recipient_awaiting_approval");
        return;
      }
      const { origin, text } = peerInput(message, peer.id);
      const result = await deps.enqueue({
        actor: assertion(authority.actor),
        conversation: {
          ...authority.conversation,
          audience: authority.conversation.audience.map(assertion),
          publishMembers: authority.conversation.publishMembers?.map(assertion),
        },
        surface: authority.surface,
        scopeVersion: authority.scopeVersion,
        text,
        origin,
        async: true,
        spawned: true,
        idempotencyKey: `peer:${id}`,
      });
      if (result.status !== "queued" || !result.runId) {
        await settle("blocked", "recipient_admission_refused");
        return;
      }
      if (await ledger.bind(id, token, result.runId)) await settle("delivered");
    } catch (error) {
      await settle("queued", "dispatch_retry_pending");
      throw error;
    }
  }

  return {
    dispatch,
    async sweep(limit = 100): Promise<void> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid dispatch batch limit");
      const pending = await deps.repository.pendingDeliveries(Date.now(), limit);
      const results = await Promise.allSettled(pending.map((row) => dispatch(row.id)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

export type PeerDispatcher = ReturnType<typeof createPeerDispatcher>;
