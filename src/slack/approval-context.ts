import type { ActorAssertion, AgentRequestDirective } from "./lib.ts";

export function resolveAgentRequestTarget(
  audience: readonly ActorAssertion[],
  targetUserId: AgentRequestDirective["targetUserId"],
  slackIdsByPrincipal?: ReadonlyMap<string, string>,
): ActorAssertion | undefined {
  return audience.find((a) => slackIdsByPrincipal?.get(a.externalId) === targetUserId || a.externalId === targetUserId);
}
