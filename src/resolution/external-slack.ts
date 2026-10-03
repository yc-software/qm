import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { RunStore } from "../runs/run-store.ts";
import { samePerson } from "../directory/person.ts";
import { conversationScope } from "./resolution-service.ts";
import { externalSlackNamespace, type ExternalSlackAccess } from "../slack/external-access.ts";
import type { TurnRequest } from "../types.ts";

export type ExternalSlackPolicies = Readonly<Record<string, ExternalSlackAccess>>;

export function externalSlackRequestAllowed(
  request: Pick<TurnRequest, "externalSlack" | "slackSource"> & {
    conversation: Pick<TurnRequest["conversation"], "kind" | "channelRef" | "threadRef">;
  },
  policies: ExternalSlackPolicies = {},
): boolean {
  const ref = request.conversation.channelRef ?? request.conversation.threadRef;
  if (request.externalSlack) {
    const supplied = request.externalSlack;
    const current = policies[supplied.accountId];
    return (
      !!current &&
      request.conversation.kind !== "dm" &&
      externalSlackNamespace(supplied.teamId, current) ===
        externalSlackNamespace(supplied.teamId, {
          companyDomains: supplied.companyDomains,
          companyTeamIds: supplied.companyTeamIds,
          serviceCredentials: supplied.serviceCredentials,
        }) &&
      ref.startsWith(`${externalSlackNamespace(supplied.teamId, current)}:`)
    );
  }
  if ([request.conversation.channelRef, request.conversation.threadRef].some((r) => r?.includes("external-slack:")))
    return false;
  if (request.slackSource) {
    const source = request.slackSource;
    const policy = policies[source.accountId];
    return (
      !policy ||
      (request.conversation.kind === "dm" &&
        source.externalPolicyNamespace === externalSlackNamespace(source.teamId, policy))
    );
  }
  return !request.conversation.threadRef.startsWith("slack-account:");
}

export async function currentExternalSlackRun(
  claims: Pick<CapabilityClaims, "runId" | "runLeaseToken" | "runAttempt" | "threadRef" | "actorId" | "scopeId">,
  deps: { runs?: RunStore; externalSlackPolicies?: ExternalSlackPolicies },
) {
  const run = claims.runId ? await deps.runs?.get(claims.runId) : null;
  if (
    !run ||
    run.status !== "running" ||
    !claims.runLeaseToken ||
    run.leaseToken !== claims.runLeaseToken ||
    run.attempts !== claims.runAttempt ||
    run.sessionId !== claims.threadRef ||
    !samePerson(run.request.actor.id, claims.actorId) ||
    (run.leaseExpiresAt ?? 0) <= Date.now() ||
    !run.request.externalSlack ||
    !externalSlackRequestAllowed(run.request, deps.externalSlackPolicies) ||
    conversationScope(run.request.conversation, run.request.actor.id) !== claims.scopeId
  )
    return null;
  return run;
}
