import type { AdminGrant } from "./admin-grant-store.ts";
import { adminStatusFromGrants, type AdminStatus } from "./admin-service.ts";
import { forEachAttributedTurn, type AttributionInput } from "./attribution.ts";
import { personKey } from "../directory/person.ts";

export interface AdminUserRow {
  principalId: string;
  sessionCount: number;
  turnCount: number;
  lastSeenAt: number | null;
  admin: AdminStatus;
}

export interface UsersInput extends AttributionInput {
  grants: readonly AdminGrant[];
  people: readonly string[];
}

export function computeUsers(input: UsersInput): AdminUserRow[] {
  const { grants, people } = input;

  const sessionsByUser = new Map<string, Set<string>>();
  const turnsByUser = new Map<string, number>();
  const lastSeenByUser = new Map<string, number>();
  const bumpLastSeen = (principalId: string, t: number) => {
    if (t > (lastSeenByUser.get(principalId) ?? 0)) lastSeenByUser.set(principalId, t);
  };

  forEachAttributedTurn(input, {
    onParticipant(sessionId, p) {
      const principalId = personKey(p.principalId);
      const set = sessionsByUser.get(principalId);
      if (set) set.add(sessionId);
      else sessionsByUser.set(principalId, new Set([sessionId]));
    },
    onTurn(p, turn) {
      const principalId = personKey(p.principalId);
      turnsByUser.set(principalId, (turnsByUser.get(principalId) ?? 0) + turn.turns);
      bumpLastSeen(principalId, turn.lastAt);
    },
  });

  const ids = new Map(people.map((p) => [personKey(p), p]));
  return [...ids]
    .map(([key, principalId]) => ({
      principalId,
      sessionCount: sessionsByUser.get(key)?.size ?? 0,
      turnCount: turnsByUser.get(key) ?? 0,
      lastSeenAt: lastSeenByUser.get(key) ?? null,
      admin: adminStatusFromGrants(grants, principalId),
    }))
    .sort((a, b) => Number(b.admin.isAdmin) - Number(a.admin.isAdmin) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}
