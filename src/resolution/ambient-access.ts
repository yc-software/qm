import { orgId } from "../config.ts";
import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { ChannelPolicyStore } from "../surface-cache/channel-policy-store.ts";
import type { ScopedConfigStore } from "./config-store.ts";

export function isAmbientActor(actorId: string): boolean {
  return actorId === `system:ambient:${orgId()}`;
}

export async function authorizesAmbientScope(
  deps: {
    directory?: Pick<DirectoryStore, "conversationMembers">;
    identity: Pick<IdentityService, "classify" | "isInternal">;
    config?: Pick<ScopedConfigStore, "getSharingPostureDurable" | "getOrgAmbientDurable">;
    channelPolicy?: Pick<ChannelPolicyStore, "get">;
  },
  claims: { scopeId: ScopeId; members?: Principal[] },
): Promise<boolean> {
  const { kind, ref } = parseScopeId(claims.scopeId);
  if (
    (kind !== "channel" && kind !== "group") ||
    (await deps.config?.getSharingPostureDurable(claims.scopeId)) !== "open" ||
    (await deps.config?.getOrgAmbientDurable()) === false
  )
    return false;
  const policy = await deps.channelPolicy?.get(ref);
  if (
    policy?.ambientEnabled === false ||
    (policy?.ambientEnabled !== true &&
      !policy?.orders?.trim() &&
      !Object.values(policy?.bots ?? {}).some((bot) => bot.mode === "action"))
  )
    return false;
  const roster = await deps.directory?.conversationMembers(kind, ref).catch(() => undefined);
  const attested = claims.members;
  return (
    !!roster?.length &&
    !!attested?.length &&
    roster.length === attested.length &&
    attested.every((member) => member.type === "internal") &&
    roster.every(
      (member) =>
        member.type === "internal" &&
        deps.identity.isInternal(deps.identity.classify(member.principalId)) &&
        attested.some((claim) => samePerson(claim.id, member.principalId)),
    )
  );
}
