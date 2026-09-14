import type { GrokJob, GrokPairing, JobView, PairingView } from "./types.ts";

export function pairingView(pairing: GrokPairing): PairingView {
  return {
    id: pairing.id,
    agentName: pairing.agentName,
    ownerPrincipalId: pairing.ownerPrincipalId,
    grokDisplayName: pairing.grokDisplayName,
    ...(pairing.grokBotId ? { grokBotId: pairing.grokBotId } : {}),
    skillRevision: pairing.skillRevision,
    consent: pairing.consent,
    status: pairing.status,
    originScopeId: pairing.originScopeId,
  };
}

export function jobView(job: GrokJob, agentName: string): JobView {
  return {
    id: job.id,
    pairingId: job.pairingId,
    agentName,
    originSessionId: job.originSessionId,
    originActorId: job.originActorId,
    instruction: job.instruction,
    status: job.status,
    seqWatermark: job.seqWatermark,
    ...(job.summary ? { summary: job.summary } : {}),
    expiresAt: job.expiresAt,
  };
}
