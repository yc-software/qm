import type { AuditEvent } from "../../audit/audit-log.ts";
import { orgId } from "../../config.ts";
import { createSpendLimits, spendLimitRefusal } from "../../ratelimit/spend-limits.ts";
import { createCanWriteScope, rosterAdmits } from "../../resolution/scope-membership.ts";
import { isSubagentThreadRef } from "../../sessions/session-syscalls.ts";
import { scopeId as toScopeId, type ScopeId, type Session, type TurnResult } from "../../types.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import type { Tenant } from "../../tenants/context.ts";

export class ProjectRosterChanged extends Error {}

type SpendLimitStatus = Awaited<ReturnType<ReturnType<typeof createSpendLimits>["status"]>>;
type Actor = OrchestratorInput["actor"];
type Conversation = OrchestratorInput["conversation"];

export async function admitSubagentSession(
  deps: OrchestratorDeps,
  conversation: Conversation,
  actor: Actor,
): Promise<{ delegatedSession: Session | null; refusal?: TurnResult }> {
  const delegatedSession = isSubagentThreadRef(conversation.threadRef)
    ? await deps.sessions.getByThread(conversation.threadRef)
    : null;
  if (isSubagentThreadRef(conversation.threadRef)) {
    const canWrite = createCanWriteScope({
      managedGroups: deps.managedGroups
        ? {
            recognizes: (ref) => deps.managedGroups!.recognizes(ref),
            members: (ref) => deps.managedGroups!.members(ref),
            membership: async (ref, id) => (await deps.managedGroups!.members(ref))?.includes(id),
          }
        : undefined,
      directory: deps.directory,
      identity: deps.identity,
    });
    if (
      !delegatedSession?.spawnMeta ||
      delegatedSession.scopeId !== deps.resolution.scopeFor(conversation, actor) ||
      !(await deps.sessions.getForParticipant(delegatedSession.id, actor.id)) ||
      !(await canWrite(actor.id, delegatedSession.scopeId))
    )
      return {
        delegatedSession,
        refusal: { status: "refused", reason: "subagent session access is no longer current" },
      };
  }
  return { delegatedSession };
}

export function createManagedRoster(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
  actor: Actor,
  conversation: Conversation,
) {
  const managedGroupRef =
    conversation.kind === "group" && conversation.channelRef && deps.managedGroups?.recognizes(conversation.channelRef)
      ? conversation.channelRef
      : undefined;
  const managedRosterIsCurrent = async (): Promise<boolean> => {
    if (!managedGroupRef) return true;
    const expected = new Set(input.sessionParticipantIds ?? []);
    const [current, version] = await Promise.all([
      deps.managedGroups!.members(managedGroupRef).catch(swallowAs("managed group roster: members", undefined)),
      deps.managedGroups!.version(managedGroupRef).catch(swallowAs("managed group roster: version", undefined)),
    ]);
    return (
      !!current &&
      version === input.scopeVersion &&
      rosterAdmits(current, actor.id, toScopeId("group", managedGroupRef)) &&
      current.length === expected.size &&
      current.every((id) => expected.has(id))
    );
  };
  const withManagedRosterVersion = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!managedGroupRef) return fn();
    const result = await deps.managedGroups!.withVersion(managedGroupRef, input.scopeVersion, fn);
    if (result === undefined) throw new ProjectRosterChanged();
    return result;
  };
  return { managedRosterIsCurrent, withManagedRosterVersion };
}

export const rosterChanged = (sessionId?: string): TurnResult => ({
  status: "refused",
  ...(sessionId ? { sessionId } : {}),
  reason: "project membership changed; retry from the current project",
});

export async function admitAudienceAndBudget(
  tenant: Tenant,
  deps: OrchestratorDeps,
  conversation: Conversation,
  actor: Actor,
  surface: ReturnType<OrchestratorDeps["surfaces"]["get"]>,
  external: boolean,
): Promise<TurnResult | undefined> {
  if (conversation.kind !== "dm" && !deps.identity.audienceIsAllInternal(conversation.audience)) {
    const externalAllowed =
      external ||
      (surface?.capabilities.externalParticipants &&
        (await deps.config.getExternalSlackParticipantsDurable(toScopeId("org", orgId()))));
    if (!externalAllowed) {
      return {
        status: "refused",
        refusalKind: "internal_only",
        reason: "internal-only: shared audience includes a non-internal participant",
      };
    }
  }

  if (deps.budget) {
    const b = await deps.budget.check(tenant, actor.id);
    if (!b.allowed) {
      return {
        status: "refused",
        reason: `budget exceeded ($${b.spentUsd.toFixed(2)} of $${b.limitUsd}); try again later`,
      };
    }
  }
  return undefined;
}

export async function checkSpendLimit(
  tenant: Tenant,
  spendLimits: ReturnType<typeof createSpendLimits> | undefined,
  deps: OrchestratorDeps,
  scopeId: ScopeId,
  audit: (event: Omit<AuditEvent, "at" | "principalId" | "scopeLabel">) => void,
): Promise<{ spendLimit: SpendLimitStatus | null; refusal?: TurnResult }> {
  const spendLimit = spendLimits
    ? await spendLimits.status(scopeId).catch((e: unknown) => {
        deps.errors.record(
          tenant,
          { category: "turn", code: "spend_limit_check", message: errMessage(e), scopeLabel: scopeId },
          e,
        );
        return null;
      })
    : null;
  if (spendLimit?.over) {
    audit({ action: "spend_limit.refused", resource: scopeId, detail: spendLimit.over });
    return {
      spendLimit,
      refusal: { status: "refused", reason: spendLimitRefusal(spendLimit), refusalKind: "model_budget" },
    };
  }
  return { spendLimit };
}
