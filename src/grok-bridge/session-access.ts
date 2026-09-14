import { samePerson } from "../directory/person.ts";
import type { ScopeId } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { SessionAccess } from "./types.ts";

export function createSessionAccess(
  sessions: Pick<SessionStore, "get" | "getForParticipant" | "participantsOf">,
  opts: { canReadScope?: (principalId: string, scope: ScopeId) => Promise<boolean> } = {},
): SessionAccess {
  const isParticipant = async (sessionId: string, principalId: string): Promise<boolean> => {
    if (await sessions.getForParticipant(sessionId, principalId)) return true;
    const participants = await sessions.participantsOf(sessionId);
    return participants.some((memberId) => samePerson(memberId, principalId));
  };

  return {
    async canRead(sessionId, actorId) {
      const session = await sessions.get(sessionId);
      if (!session) return false;
      if (await isParticipant(sessionId, actorId)) return true;
      return opts.canReadScope ? opts.canReadScope(actorId, session.scopeId) : false;
    },
    async ownerIsMember(sessionId, ownerId) {
      if (!(await sessions.get(sessionId))) return false;
      return isParticipant(sessionId, ownerId);
    },
  };
}
