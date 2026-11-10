import type { TriggerSpec } from "../triggers/run-trigger.ts";
import type { TriggerBase } from "../triggers/types.ts";

type TriggerAuthority = Pick<TriggerSpec, "owner" | "ownerScopeId" | "botActor">;

export function authoredNow(atKeyboard: boolean): { taskAuthor?: "automation" } {
  return atKeyboard ? {} : { taskAuthor: "automation" };
}

export function reauthored(
  atKeyboard: boolean,
  trigger: Pick<TriggerBase, "taskAuthor">,
): { taskAuthor?: "automation" | null } {
  if (!atKeyboard) return authoredNow(false);
  return trigger.taskAuthor ? { taskAuthor: null } : {};
}

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
