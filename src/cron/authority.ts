import type { Cron } from "../types.ts";
import type { TriggerSpec } from "../triggers/run-trigger.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { App } from "../api/app.ts";
import type { AdminService } from "../admin/admin-service.ts";

type TriggerAuthority = Pick<TriggerSpec, "owner" | "ownerScopeId" | "runAs" | "unattendedGrants" | "members">;

export function cronTriggerAuthority(cron: TriggerAuthority): TriggerAuthority {
  return {
    owner: cron.owner,
    ownerScopeId: cron.ownerScopeId,
    ...(cron.runAs ? { runAs: cron.runAs } : {}),
    ...(cron.unattendedGrants ? { unattendedGrants: [...cron.unattendedGrants] } : {}),
    ...(cron.members ? { members: cron.members } : {}),
  };
}

export async function unattendedGrantRefusal(
  app: App,
  admin: AdminService | undefined,
  cron: Pick<Cron, "owner" | "ownerScopeId" | "runAs">,
  capability: Pick<CapabilityClaims, "actorId" | "liveActor">,
): Promise<string | null> {
  if (capability.liveActor !== true) return "unattended grants require a live turn started by the cron owner";
  if (!(await app.samePerson(cron.owner, capability.actorId))) return "only the cron owner may set unattended grants";
  if (!cron.ownerScopeId.startsWith("personal:") || (cron.runAs !== undefined && cron.runAs !== "owner"))
    return "unattended grants require a personal-scope cron that runs as its owner";
  const status = await admin?.adminStatusOf({ id: capability.actorId, type: "internal" }).catch(() => undefined);
  if (!status?.isAdmin) return "unattended grants require the cron owner to be a current org admin";
  return null;
}
