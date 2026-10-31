import { DISCORD_DM_DELIVERY_TYPE, discordUserIdOf } from "../discord/config.ts";
import type { DiscordInstallationStore } from "../surfaces/discord-installation.ts";
import { reportFailureAs } from "../util/errors.ts";
import { personIds } from "../directory/person.ts";
import { slackIdOf, type DirectoryStore } from "../directory/directory-store.ts";
import type { DeliveryStore } from "./delivery-store.ts";

export type PrincipalRoute = (principalId: string) => Promise<string | null>;

export function withPrincipalRouting(store: DeliveryStore, route: PrincipalRoute): DeliveryStore {
  return {
    ...store,
    async enqueue(input) {
      if (input.destination.type !== "principal" || input.destination.commandApprovalId) return store.enqueue(input);
      const discordOnly = discordUserIdOf(input.destination.target) !== null;
      const type = await route(input.destination.target).catch((err: unknown) => {
        if (discordOnly) throw err;
        reportFailureAs("principal-routing", undefined)(err);
        return null;
      });
      if (discordOnly && !type) throw new Error(`discord delivery unavailable for ${input.destination.target}`);
      return store.enqueue(type ? { ...input, destination: { ...input.destination, type } } : input);
    },
  };
}

export function slackAccountOf(directory: Pick<DirectoryStore, "get">): (principalId: string) => Promise<boolean> {
  return async (principalId) => {
    for (const id of new Set([principalId, ...personIds(principalId)])) {
      const member = await directory.get(id);
      if (slackIdOf({ principalId: id }) !== undefined || (member && slackIdOf(member) !== undefined)) return true;
    }
    return false;
  };
}

export function createDiscordPrincipalRoute(deps: {
  installation: Pick<DiscordInstallationStore, "status">;
  linkedDiscordUserIds(principalId: string): string[];
  hasSlackAccount(principalId: string): Promise<boolean>;
}): PrincipalRoute {
  return async (principalId) => {
    if (!deps.linkedDiscordUserIds(principalId).length) return null;
    if (discordUserIdOf(principalId) === null && (await deps.hasSlackAccount(principalId))) return null;
    const status = await deps.installation.status();
    if (!status.configured) return null;
    return DISCORD_DM_DELIVERY_TYPE;
  };
}
