import type { TriggerSpec } from "../triggers/run-trigger.ts";
import type { TriggerBase } from "../triggers/types.ts";

type TriggerAuthority = Pick<TriggerSpec, "owner" | "ownerScopeId" | "botActor">;

export function ownerAuthored(trigger: Pick<TriggerBase, "taskAuthor">): boolean {
  return trigger.taskAuthor !== "automation";
}

export function cronTriggerAuthority(cron: TriggerAuthority): TriggerAuthority {
  return {
    owner: cron.owner,
    ownerScopeId: cron.ownerScopeId,
    ...(cron.botActor ? { botActor: true } : {}),
  };
}
