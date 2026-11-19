import { pickMatch, type DirectoryMember, type DirectoryStore } from "./directory-store.ts";
import { personKey } from "./person.ts";
import { externalMemberActive } from "../identity/external-members.ts";
import { personLabel } from "../identity/person-names.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { UserStore } from "../identity/user-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";

export interface SignInMemberSources {
  identity: Pick<IdentityService, "listExternalMembers" | "classify">;
  sessions?: Pick<SessionStore, "distinctParticipants">;
  users?: Pick<UserStore, "resolve">;
  emailAuthMembers?: DirectoryMember[];
}

export async function signInMembers(src: SignInMemberSources): Promise<DirectoryMember[]> {
  const [externals, participants] = await Promise.all([
    src.identity.listExternalMembers(),
    src.sessions?.distinctParticipants() ?? [],
  ]);
  const users = await src.users?.resolve(participants).catch(() => undefined);
  const candidates: DirectoryMember[] = [
    ...(src.emailAuthMembers ?? []),
    ...externals
      .filter((member) => externalMemberActive(member))
      .map((member) => ({ principalId: member.email, displayName: member.email, type: "internal" as const })),
    ...participants
      .filter((principalId) => src.identity.classify(principalId).type === "internal")
      .map((principalId) => ({
        principalId,
        displayName: personLabel(principalId, { user: users?.get(principalId) }),
        type: "internal" as const,
      })),
  ];
  const byKey = new Map<string, DirectoryMember>();
  for (const member of candidates) {
    const key = personKey(member.principalId);
    if (key && !byKey.has(key)) byKey.set(key, member);
  }
  return [...byKey.values()];
}

export function withSignInMembers(directory: DirectoryStore, src: SignInMemberSources): DirectoryStore {
  return {
    ...directory,
    async resolve(query) {
      const stored = await directory.resolve(query);
      if (stored.kind !== "none") return stored;
      const match = pickMatch(
        await signInMembers(src),
        query,
        (member) => member.principalId,
        (member) => member.displayName,
      );
      if (match.kind === "one") return { kind: "one", member: match.item };
      if (match.kind === "ambiguous") return { kind: "ambiguous", candidates: match.items };
      return { kind: "none" };
    },
  };
}
