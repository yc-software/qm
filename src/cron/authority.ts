import type { TriggerSpec } from "../triggers/run-trigger.ts";
import type { Cron } from "../triggers/types.ts";

type TriggerAuthority = Pick<TriggerSpec, "owner" | "ownerScopeId" | "botActor">;

export function cronOwnerFire(cron: Pick<Cron, "taskAuthor">): boolean {
  return cron.taskAuthor !== "automation";
}

export function cronTriggerAuthority(cron: TriggerAuthority): TriggerAuthority {
  return {
    owner: cron.owner,
    ownerScopeId: cron.ownerScopeId,
    ...(cron.botActor ? { botActor: true } : {}),
  };
}
