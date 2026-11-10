import type { AdminGrant } from "./admin-grant-store.ts";
import { adminStatusFromGrants, type AdminStatus } from "./admin-service.ts";
import type { UserActivity, UserRecord } from "../identity/user-store.ts";

export interface AdminUserRow {
  userId: string;
  principalId: string;
  aliases: string[];
  kind: UserRecord["kind"];
  sessionCount: number;
  turnCount: number;
  lastSeenAt: number | null;
  firstSeenAt: number | null;
  source: UserRecord["source"] | null;
  offboarded: boolean;
  admin: AdminStatus;
}

export interface UsersInput {
  roster: readonly UserRecord[];
  activity: readonly UserActivity[];
  grants: readonly AdminGrant[];
}

export function computeUsers({ roster, activity, grants }: UsersInput): AdminUserRow[] {
  const byUser = new Map(activity.flatMap((a) => (a.userId ? [[a.userId, a] as const] : [])));
  return roster
    .map((user) => {
      const seen = byUser.get(user.id);
      return {
        userId: user.id,
        principalId: user.principalId,
        aliases: user.aliases,
        kind: user.kind,
        sessionCount: seen?.sessions ?? 0,
        turnCount: seen?.turns ?? 0,
        lastSeenAt: seen?.lastSeenAt ?? null,
        firstSeenAt: user.firstSeenAt ?? null,
        source: user.source ?? null,
        offboarded: user.offboardedAt !== undefined,
        admin: adminStatusFromGrants(grants, user.principalId),
      };
    })
    .sort((a, b) => Number(b.admin.isAdmin) - Number(a.admin.isAdmin) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}
