import { personKey, samePerson } from "../../directory/person.ts";
import { principalDestination } from "../../reach/reach.ts";
import type { Tenant } from "../../tenants/context.ts";
import type { Conversation, Principal } from "../../types.ts";
import { adminProvidersUrl, personalSettingsUrl } from "../../util/admin-links.ts";
import { swallow } from "../../util/errors.ts";
import { modelBudgetMessage } from "../turn-error.ts";
import type { OrchestratorDeps } from "./types.ts";

export async function handleModelBudgetCap(
  deps: Pick<OrchestratorDeps, "admin" | "deliveries" | "publicWebUrl" | "userModelCredentials">,
  tenant: Tenant,
  conversation: Pick<Conversation, "kind">,
  actor: Principal,
  external: boolean,
): Promise<string> {
  const providersUrl = deps.publicWebUrl ? adminProvidersUrl(deps.publicWebUrl) : undefined;
  const settingsUrl = deps.publicWebUrl ? personalSettingsUrl(deps.publicWebUrl) : undefined;
  const internalMember = !external && actor.type === "internal";
  const inDm = conversation.kind === "dm";
  const isAdmin =
    internalMember && inDm && deps.admin
      ? (await deps.admin.adminStatusOf(tenant, actor).catch(() => ({ isAdmin: false }))).isAdmin
      : false;

  if (deps.admin) {
    const adminNotice = modelBudgetMessage({ isAdmin: true, providersUrl });
    const dayBucket = Math.floor(Date.now() / 86_400_000);
    try {
      const grants = await deps.admin.listGrants(tenant);
      const seen = new Set<string>();
      for (const grant of grants) {
        if (grant.role !== "org_admin" && grant.role !== "owner") continue;
        const key = personKey(grant.principalId);
        if (seen.has(key)) continue;
        seen.add(key);
        if (isAdmin && samePerson(grant.principalId, actor.id)) continue;
        await deps.deliveries
          .enqueue({
            destination: principalDestination(grant.principalId, actor.id),
            text: adminNotice,
            idempotencyKey: `model-budget-cap:${key}:${dayBucket}`,
          })
          .catch((e) => swallow("orchestrator: notify admin of model budget cap", e));
      }
    } catch (e) {
      swallow("orchestrator: list admins for model budget cap", e);
    }
  }

  return modelBudgetMessage({
    isAdmin,
    providersUrl: isAdmin ? providersUrl : undefined,
    settingsUrl: internalMember ? settingsUrl : undefined,
    personalModelAuth: internalMember && Boolean(deps.userModelCredentials),
  });
}
