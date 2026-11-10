import type { CandidateDestination, Destination } from "../types.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";

const stripCandidate = (c: CandidateDestination): Destination => ({
  type: c.type,
  target: c.target,
  ...(c.webhook ? { webhook: c.webhook } : {}),
  ...(c.audienceScopeId ? { audienceScopeId: c.audienceScopeId } : {}),
});

export function resolveCapabilityDestination(
  cap: CapabilityClaims,
  destinationKey: string | undefined,
): { ok: true; destination: Destination | undefined } | { ok: false } {
  if (destinationKey !== undefined) {
    const chosen = cap.destinations?.find((d) => d.key === destinationKey);
    return chosen ? { ok: true, destination: stripCandidate(chosen) } : { ok: false };
  }
  const def = cap.destinations?.find((d) => d.key === cap.defaultDestinationKey);
  if (def) return { ok: true, destination: stripCandidate(def) };
  if (!cap.destination) return { ok: true, destination: undefined };
  const { persona: _worn, ...stored } = cap.destination;
  return { ok: true, destination: stored };
}
