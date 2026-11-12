import { orgId } from "../config.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { ScopeId } from "../types.ts";
import { externalSlackRequestAllowed, type ExternalSlackPolicies } from "./external-slack.ts";
import { conversationScope } from "./resolution-service.ts";

export const ambientActorId = () => `system:ambient:${orgId()}`;

type WakeRequest = Pick<OrchestratorInput, "actor" | "conversation" | "surfaceOrigin" | "botActor"> &
  Partial<Pick<OrchestratorInput, "origin" | "surface">>;

export function withAmbientWakes(
  canWriteScope: (principalId: string, scope: ScopeId) => Promise<boolean>,
  policies: ExternalSlackPolicies = {},
) {
  return async (request: WakeRequest, scope: ScopeId): Promise<boolean> =>
    (request.actor.id === ambientActorId() &&
      request.origin?.kind === "automation" &&
      !request.botActor &&
      request.surfaceOrigin?.audience === "internal" &&
      conversationScope(request.conversation, request.actor.id) === scope &&
      externalSlackRequestAllowed({ ...request, surface: request.surface ?? "" }, policies)) ||
    canWriteScope(request.actor.id, scope);
}
