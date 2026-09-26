import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { RunStore } from "../runs/run-store.ts";
import { samePerson } from "../directory/person.ts";
import { conversationScope } from "./resolution-service.ts";
import { externalSlackNamespace, type ExternalSlackAccess } from "../slack/external-access.ts";
import type { TurnRequest } from "../types.ts";

export type ExternalSlackPolicies = Readonly<Record<string, ExternalSlackAccess>>;

export function externalSlackRequestAllowed(
  request: Pick<TurnRequest, "externalSlack" | "slackSource" | "surface"> & {
    conversation: Pick<TurnRequest["conversation"], "kind" | "channelRef" | "threadRef">;
  },
  policies: ExternalSlackPolicies = {},
  historicalSlack = false,
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
          serviceCredentials: supplied.serviceCredentials,
        }) &&
      ref.startsWith(`${externalSlackNamespace(supplied.teamId, current)}:`)
    );
  }
  if (ref.includes("external-slack:")) return false;
  if (request.conversation.kind === "dm") return true;
  if (request.slackSource) return !policies[request.slackSource.accountId];
  return !(Object.keys(policies).length && (request.surface === "slack" || historicalSlack));
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
    !externalSlackRequestAllowed({ ...run.request, surface: run.request.surface ?? "" }, deps.externalSlackPolicies) ||
    conversationScope(run.request.conversation, run.request.actor.id) !== claims.scopeId
  )
    return null;
  return run;
}
