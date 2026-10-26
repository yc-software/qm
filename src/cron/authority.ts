import type { Cron } from "../types.ts";
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

export function grantsStayWithOwner(cron: Pick<Cron, "owner" | "ownerScopeId" | "destination">): boolean {
  const ownersOwn = (scope: string | undefined): boolean => {
    const parsed = parseScopeId(scope ?? "");
    return parsed.kind === "personal" && samePerson(parsed.ref, cron.owner);
  };
  return ownersOwn(cron.ownerScopeId) && (!cron.destination || ownersOwn(cron.destination.audienceScopeId));
}

export interface UnattendedGrantRefusal {
  code: "bad_request" | "forbidden";
  message: string;
}

export async function unattendedGrantRefusal(
  app: App,
  admin: AdminService | undefined,
  cron: Pick<Cron, "owner" | "ownerScopeId" | "destination">,
  capability: Pick<CapabilityClaims, "actorId" | "liveActor">,
): Promise<UnattendedGrantRefusal | null> {
  const forbidden = (message: string): UnattendedGrantRefusal => ({ code: "forbidden", message });
  if (capability.liveActor !== true)
    return forbidden("unattended grants require a live turn started by the cron owner");
  if (!(await app.samePerson(cron.owner, capability.actorId)))
    return forbidden("only the cron owner may set unattended grants");
  if (!grantsStayWithOwner(cron))
    return {
      code: "bad_request",
      message:
        "unattended grants require a cron that lives in its owner's own DM and delivers only to them — admin reads must not reach a shared room or another person; create it from the owner's DM without a channel, recipient or group",
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
