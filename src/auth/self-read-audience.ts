import { ownPrivateConversation } from "../directory/person.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import type { CapabilityClaims } from "./capability-token.ts";

export type SelfReadAudience = { inOwnPrivate: boolean; roomScope?: ScopeId };

export function selfReadAudience(
  capability: CapabilityClaims | null | undefined,
  principalId: string,
): SelfReadAudience {
  if (!capability) return { inOwnPrivate: true };
  const audience =
    capability.audienceScopeId ??
    capability.destination?.audienceScopeId ??
    (capability.origin !== undefined && capability.origin !== "conversation" ? undefined : capability.scopeId);
  if (ownPrivateConversation(principalId, capability.scopeId, audience)) {
    return { inOwnPrivate: true };
  }
  return {
    inOwnPrivate: false,
    roomScope: audience && parseScopeId(audience).kind !== "personal" ? audience : undefined,
  };
}
