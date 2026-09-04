import type { CandidateDestination, Destination } from "../types.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";

const stripCandidate = (c: CandidateDestination): Destination => ({
  type: c.type,
  target: c.target,
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
  return { ok: true, destination: def ? stripCandidate(def) : cap.destination };
}
