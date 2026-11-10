import type { TriggerSpec } from "../triggers/run-trigger.ts";

type TriggerAuthority = Pick<TriggerSpec, "owner" | "ownerScopeId">;

export function cronTriggerAuthority(cron: TriggerAuthority): TriggerAuthority {
  return { owner: cron.owner, ownerScopeId: cron.ownerScopeId };
}
