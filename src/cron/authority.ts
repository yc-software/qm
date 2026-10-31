import type { Cron } from "../triggers/types.ts";
import type { TriggerSpec } from "../triggers/run-trigger.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { App } from "../api/app.ts";
import type { AdminService } from "../admin/admin-service.ts";
import { errMessage } from "../util/errors.ts";
import { parseScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";

type TriggerAuthority = Pick<TriggerSpec, "owner" | "ownerScopeId" | "unattendedGrants">;

export function cronTriggerAuthority(cron: TriggerAuthority): TriggerAuthority {
  return {
    owner: cron.owner,
    ownerScopeId: cron.ownerScopeId,
    ...(cron.unattendedGrants ? { unattendedGrants: [...cron.unattendedGrants] } : {}),
  };
}

export function grantsHomedWithOwner(cron: Pick<Cron, "owner" | "ownerScopeId">): boolean {
  const home = parseScopeId(cron.ownerScopeId);
  return home.kind === "personal" && samePerson(home.ref, cron.owner);
}

export interface UnattendedGrantRefusal {
  code: "bad_request" | "forbidden";
  message: string;
}

export async function unattendedGrantRefusal(
  app: App,
  admin: AdminService | undefined,
  cron: Pick<Cron, "owner" | "ownerScopeId">,
  capability: Pick<CapabilityClaims, "actorId" | "liveActor">,
): Promise<UnattendedGrantRefusal | null> {
  const forbidden = (message: string): UnattendedGrantRefusal => ({ code: "forbidden", message });
  if (capability.liveActor !== true)
    return forbidden("unattended grants require a live turn started by the cron owner");
  if (!(await app.samePerson(cron.owner, capability.actorId)))
    return forbidden("only the cron owner may set unattended grants or change a cron that carries them");
  if (!grantsHomedWithOwner(cron))
    return {
      code: "bad_request",
      message:
        "unattended grants require a cron that lives in its owner's own DM — create it from the owner's DM without a channel or group; its output can still go elsewhere",
    };
  let status: Awaited<ReturnType<AdminService["adminStatusOf"]>> | undefined;
  try {
    status = await admin?.adminStatusOf({ id: capability.actorId, type: "internal" });
  } catch (e) {
    return forbidden(`unattended grants could not confirm the cron owner is a current org admin: ${errMessage(e)}`);
  }
  if (!status?.isAdmin) return forbidden("unattended grants require the cron owner to be a current org admin");
  return null;
}
