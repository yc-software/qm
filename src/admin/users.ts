import type { AdminGrant } from "./admin-grant-store.ts";
import { adminStatusFromGrants, type AdminStatus } from "./admin-service.ts";
import { forEachAttributedTurn, type AttributionInput } from "./attribution.ts";

export interface AdminUserRow {
  principalId: string;
  sessionCount: number;
  turnCount: number;
  lastSeenAt: number | null;
  admin: AdminStatus;
}

export interface UsersInput extends Omit<AttributionInput, "sessionIds"> {
  grants: readonly AdminGrant[];
}

export function computeUsers(input: UsersInput): AdminUserRow[] {
  const { grants } = input;

  const sessionsByUser = new Map<string, Set<string>>();
  const turnsByUser = new Map<string, number>();
  const lastSeenByUser = new Map<string, number>();
  const bumpLastSeen = (principalId: string, t: number) => {
    if (t > (lastSeenByUser.get(principalId) ?? 0)) lastSeenByUser.set(principalId, t);
  };

  forEachAttributedTurn(input, {
    onWindow(sessionId, w) {
      const set = sessionsByUser.get(w.principalId);
      if (set) set.add(sessionId);
      else sessionsByUser.set(w.principalId, new Set([sessionId]));
      bumpLastSeen(w.principalId, w.validFrom);
    },
    onTurn(w, turn) {
      turnsByUser.set(w.principalId, (turnsByUser.get(w.principalId) ?? 0) + turn.turns);
      bumpLastSeen(w.principalId, turn.lastAt);
    },
  });

  const ids = new Set<string>([...sessionsByUser.keys(), ...grants.map((g) => g.principalId)]);
  return [...ids]
    .map((principalId) => ({
      principalId,
      sessionCount: sessionsByUser.get(principalId)?.size ?? 0,
      turnCount: turnsByUser.get(principalId) ?? 0,
      lastSeenAt: lastSeenByUser.get(principalId) ?? null,
      admin: adminStatusFromGrants(grants, principalId),
    }))
    .sort((a, b) => Number(b.admin.isAdmin) - Number(a.admin.isAdmin) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}
