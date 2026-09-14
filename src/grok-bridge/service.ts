import { randomUUID } from "node:crypto";
import { mintCallbackToken } from "./crypto.ts";
import { createJobLifecycle } from "./jobs.ts";
import { createPairingLifecycle } from "./pairing.ts";
import type { GrokBridge, GrokBridgeDeps } from "./types.ts";

export type { GrokBridge, GrokBridgeDeps } from "./types.ts";

export function createGrokBridge(deps: GrokBridgeDeps): GrokBridge {
  const now = deps.now ?? Date.now;
  const id = deps.id ?? randomUUID;
  const mintToken = deps.mintToken ?? mintCallbackToken;
  const pairings = createPairingLifecycle({
    pairings: deps.pairings,
    secrets: deps.secrets,
    now,
    id,
  });
  const jobs = createJobLifecycle({
    pairings: deps.pairings,
    jobs: deps.jobs,
    secrets: deps.secrets,
    sessions: deps.sessions,
    outbound: deps.outbound,
    projector: deps.projector,
    now,
    id,
    mintToken,
  });
  return {
    requestPairing: (input) => pairings.requestPairing(input),
    decidePairing: (pairingId, ownerId, decision) => pairings.decidePairing(pairingId, ownerId, decision),
    completeInbound: (pairingId, ownerId, inbound) => pairings.completeInbound(pairingId, ownerId, inbound),
    async revoke(pairingId, actorId) {
      const pairing = await pairings.revoke(pairingId, actorId);
      await jobs.failInFlight(pairing.id, "pairing revoked");
    },
    dispatch: (input) => jobs.dispatch(input),
    ingest: (jobId, raw, authorizationHeader) => jobs.ingest(jobId, raw, authorizationHeader),
    getJob: (jobId, viewerId) => jobs.getJob(jobId, viewerId),
  };
}
