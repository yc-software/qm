import { orgId } from "../config.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import { sessionTreeRoot } from "../sessions/session-syscalls.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { ScopeId, Session } from "../types.ts";
import { externalSlackRequestAllowed, type ExternalSlackPolicies } from "./external-slack.ts";
import { conversationScope } from "./resolution-service.ts";

export const ambientActorId = () => `system:ambient:${orgId()}`;

type WakeRequest = Pick<OrchestratorInput, "actor" | "conversation" | "surfaceOrigin" | "botActor" | "surface">;

export function withAmbientWakes(
  canWriteScope: (principalId: string, scope: ScopeId) => Promise<boolean>,
  policies: ExternalSlackPolicies = {},
) {
  return async (request: WakeRequest, scope: ScopeId): Promise<boolean> =>
    (request.actor.id === ambientActorId() &&
      !request.botActor &&
      request.surfaceOrigin?.audience === "internal" &&
      conversationScope(request.conversation, request.actor.id) === scope &&
      externalSlackRequestAllowed({ ...request, surface: request.surface ?? "" }, policies)) ||
    canWriteScope(request.actor.id, scope);
}

export async function ambientWakeReaches(
  sessions: Pick<SessionStore, "get">,
  request: WakeRequest,
  target: Session,
  from: Session,
): Promise<boolean> {
  if (request.actor.id !== ambientActorId() || target.id === from.id) return true;
  const [a, b] = await Promise.all([sessionTreeRoot(sessions, target), sessionTreeRoot(sessions, from)]);
  return a.id === b.id;
}
