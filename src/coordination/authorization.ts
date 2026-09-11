import type { App } from "../api/app-types.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import { parseScopeId } from "../types.ts";
import type { Peer, PeerAuthority } from "./types.ts";

export function peerPrincipalSignature(principal: PeerAuthority["actor"]): string {
  return JSON.stringify([principal.id, principal.type, [...new Set(principal.teamIds ?? [])].sort()]);
}
export function peerAudienceMatches(
  current: PeerAuthority["conversation"],
  previous: PeerAuthority["conversation"],
): boolean {
  const roster = (members: PeerAuthority["conversation"]["audience"] = []) =>
    JSON.stringify([...new Set(members.map(peerPrincipalSignature))].sort());
  return (
    current.kind === previous.kind &&
    current.channelRef === previous.channelRef &&
    current.isPrivate === previous.isPrivate &&
    current.isMpim === previous.isMpim &&
    roster(current.audience) === roster(previous.audience) &&
    roster(current.publishMembers) === roster(previous.publishMembers)
  );
}
export function createPeerAuthorization(deps: {
  identity: IdentityService;
  projects: ProjectStore;
  directory: DirectoryStore;
  app: Pick<App, "belongsToScope" | "authorizesCapabilityScope">;
}) {
  const { identity, projects, directory, app } = deps;
  return async function authorizePeer(peer: Peer): Promise<PeerAuthority | null> {
    await identity.refresh();
    const authority = peer.authority;
    if (!authority) return null;
    const actor = identity.classify(authority.actor.id);
    if (!identity.isInternal(actor)) return null;
    const { kind, ref } = parseScopeId(peer.scopeId);
    const scopeVersion =
      kind === "group" && projects.recognizes(ref) ? await projects.version(ref) : authority.scopeVersion;
    const authorized =
      (await app.belongsToScope(actor.id, peer.scopeId)) &&
      (await app.authorizesCapabilityScope({
        actorId: actor.id,
        scopeId: peer.scopeId,
        scopeVersion,
        liveActor: false,
        botActor: false,
      }));
    if (!authorized) return null;
    if ((kind === "channel" || kind === "group") && !(kind === "group" && projects.recognizes(ref))) {
      const members = await directory.conversationMembers(kind, ref);
      if (!members?.length) return null;
      const audience = members.map((member) => identity.classify(member.principalId, member.type === "guest"));
      const isPrivate = kind === "channel" ? await directory.channelPrivacy(ref) : true;
      if (isPrivate === undefined) return null;
      return {
        ...authority,
        actor,
        scopeVersion,
        conversation: { ...authority.conversation, audience, publishMembers: audience, isPrivate },
      };
    }
    const audience =
      kind === "group" && projects.recognizes(ref)
        ? ((await projects.members(ref)) ?? [])
            .map((id) => identity.classify(id))
            .filter((member) => identity.isInternal(member))
        : authority.conversation.audience.map((member) => identity.classify(member.id));
    if (!audience.some((member) => member.id === actor.id)) audience.push(actor);
    const publishMembers =
      kind === "group" && projects.recognizes(ref)
        ? audience
        : authority.conversation.publishMembers?.map((member) => identity.classify(member.id));
    return {
      ...authority,
      actor,
      scopeVersion,
      conversation: { ...authority.conversation, audience, ...(publishMembers ? { publishMembers } : {}) },
    };
  };
}
