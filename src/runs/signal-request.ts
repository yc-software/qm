import type { OrchestratorInput } from "../core/orchestrator.ts";
import type { TurnRequest } from "../types.ts";

export function signalReplayRequest(input: OrchestratorInput): TurnRequest {
  const { actor, conversation, ...request } = input;
  return {
    ...request,
    surface: request.surface ?? "slack",
    actor: { externalId: actor.id, ...(actor.displayName ? { displayName: actor.displayName } : {}) },
    conversation: {
      ...conversation,
      audience: conversation.audience?.map((person) => ({ externalId: person.id })),
      publishMembers: conversation.publishMembers?.map((person) => ({ externalId: person.id })),
    },
  };
}
