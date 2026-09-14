import { personalScope } from "../types.ts";
import { requireAgentName, requireInternalActor, requireOwner, requirePairing } from "./authz.ts";
import { GROK_BRIDGE_SKILL_REVISION, grokDisplayName, inboundRefFor } from "./crypto.ts";
import {
  GrokBridgeError,
  type GrokPairing,
  type InboundCreds,
  type PairingStore,
  type PairingView,
  type RequestPairing,
  type SecretVault,
} from "./types.ts";
import { pairingView } from "./views.ts";

export interface PairingLifecycle {
  requestPairing(input: RequestPairing): Promise<PairingView>;
  decidePairing(id: string, ownerId: string, decision: "accept" | "decline"): Promise<PairingView>;
  completeInbound(id: string, ownerId: string, inbound: InboundCreds): Promise<PairingView>;
  revoke(id: string, actorId: string): Promise<GrokPairing>;
}

export function createPairingLifecycle(deps: {
  pairings: PairingStore;
  secrets: SecretVault;
  now: () => number;
  id: () => string;
}): PairingLifecycle {
  return {
    async requestPairing(input) {
      requireInternalActor(input.actorType, "create pairings");
      const agentName = requireAgentName(input.agentName);
      const existing = await deps.pairings.findActive(input.ownerPrincipalId, agentName);
      if (existing) return pairingView(existing);
      const createdAt = deps.now();
      const pairing = await deps.pairings.create({
        id: deps.id(),
        agentName,
        ownerPrincipalId: input.ownerPrincipalId,
        grokDisplayName: grokDisplayName(agentName),
        skillRevision: GROK_BRIDGE_SKILL_REVISION,
        consent: { recipientId: input.ownerPrincipalId, status: "pending" },
        status: "pending_consent",
        originScopeId: input.originScopeId || personalScope(input.ownerPrincipalId),
        createdAt,
        updatedAt: createdAt,
      });
      const winner = await deps.pairings.findActive(input.ownerPrincipalId, agentName);
      if (winner && winner.id !== pairing.id) {
        await deps.pairings.save({ ...pairing, status: "revoked", updatedAt: deps.now() });
        return pairingView(winner);
      }
      return pairingView(pairing);
    },

    async decidePairing(id, ownerId, decision) {
      const pairing = await requirePairing(deps.pairings.get, id);
      requireOwner(pairing, ownerId);
      if (pairing.status !== "pending_consent") {
        throw new GrokBridgeError("conflict", 409, "pairing is not waiting on consent");
      }
      const decidedAt = deps.now();
      if (decision === "decline") {
        return pairingView(
          await deps.pairings.save({
            ...pairing,
            consent: { ...pairing.consent, status: "declined", decidedAt },
            status: "revoked",
            updatedAt: decidedAt,
          }),
        );
      }
      return pairingView(
        await deps.pairings.save({
          ...pairing,
          consent: { ...pairing.consent, status: "accepted", decidedAt },
          status: "awaiting_inbound",
          updatedAt: decidedAt,
        }),
      );
    },

    async completeInbound(id, ownerId, inbound) {
      const pairing = await requirePairing(deps.pairings.get, id);
      requireOwner(pairing, ownerId);
      if (pairing.status !== "awaiting_inbound" && pairing.status !== "degraded") {
        throw new GrokBridgeError("conflict", 409, "pairing is not waiting for inbound credentials");
      }
      if (pairing.consent.status !== "accepted") {
        throw new GrokBridgeError("forbidden", 403, "owner has not accepted this pairing");
      }
      try {
        new URL(inbound.webhookUrl);
      } catch {
        throw new GrokBridgeError("bad_request", 400, "webhookUrl must be an absolute URL");
      }
      if (!inbound.webhookKey.trim()) {
        throw new GrokBridgeError("bad_request", 400, "webhookKey is required");
      }
      const inboundRef = inboundRefFor(pairing.id);
      await deps.secrets.put(inboundRef, { url: inbound.webhookUrl, bearer: inbound.webhookKey.trim() });
      const updatedAt = deps.now();
      return pairingView(
        await deps.pairings.save({
          ...pairing,
          inboundRef,
          ...(inbound.grokBotId ? { grokBotId: inbound.grokBotId } : {}),
          status: "paired",
          updatedAt,
        }),
      );
    },

    async revoke(id, actorId) {
      const pairing = await requirePairing(deps.pairings.get, id);
      requireOwner(pairing, actorId);
      const updatedAt = deps.now();
      const revoked = await deps.pairings.save({ ...pairing, status: "revoked", updatedAt });
      if (pairing.inboundRef) await deps.secrets.delete(pairing.inboundRef);
      return revoked;
    },
  };
}
