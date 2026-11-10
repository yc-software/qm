import type { TriggerSpec } from "../triggers/run-trigger.ts";

type TriggerAuthority = Pick<TriggerSpec, "owner" | "ownerScopeId">;

/** A fire runs as the person whose standing instructions it carries, with that person's own authority. */
export function cronTriggerAuthority(cron: TriggerAuthority): TriggerAuthority {
  return { owner: cron.owner, ownerScopeId: cron.ownerScopeId };
}
