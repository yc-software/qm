import { foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { SharingPosture } from "../resolution/sharing-posture.ts";
import type { Conversation, Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";

interface Team {
  id: string;
  name: string;
  isolatedInOpen: boolean;
  rooms: ScopeId[];
  memberCount: number;
}

export interface TurnTeam {
  id: string;
  name: string;
  isolatedInOpen: boolean;
  configured: boolean;
  present: ReadonlySet<string>;
}

export interface TeamChange {
  id: string;
  remove?: boolean;
  name?: string;
  isolatedInOpen?: boolean;
  addMembers?: readonly string[];
  addAdmins?: readonly string[];
  drop?: readonly string[];
  addRooms?: readonly ScopeId[];
  dropRooms?: readonly ScopeId[];
}

export interface TeamStore {
  list(): Promise<Team[]>;
  forTurn(scope: ScopeId, principalIds: readonly string[]): Promise<TurnTeam[]>;
  isMember(principalId: string, teamId: string): Promise<boolean>;
  apply(change: TeamChange, actorId: string): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams(
    team_id          TEXT    PRIMARY KEY,
    name             TEXT    NOT NULL,
    isolated_in_open BOOLEAN NOT NULL DEFAULT FALSE,
    created_by       TEXT    NOT NULL,
    created_at       BIGINT  NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_members(
    team_id      TEXT   NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    principal_id TEXT   NOT NULL,
    role         TEXT   NOT NULL CHECK (role IN ('member', 'admin')),
    added_by     TEXT   NOT NULL,
    added_at     BIGINT NOT NULL,
    PRIMARY KEY (team_id, principal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS team_members_principal ON team_members (principal_id)`,
  `CREATE TABLE IF NOT EXISTS team_rooms(
    team_id  TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL,
    PRIMARY KEY (team_id, scope_id)
  )`,
  `CREATE INDEX IF NOT EXISTS team_rooms_scope ON team_rooms (scope_id)`,
];

const keysOf = (id: string) => personIds(id).map(foldPrincipalId);
const onTeam = (team: TurnTeam, principalId: string) => keysOf(principalId).some((k) => team.present.has(k));

export function createPostgresTeamStore(
  connectionString: string,
  flags: Pick<FeatureFlagStore, "enabled">,
  orgScope: ScopeId,
): TeamStore {
  const { q, pool } = createPgPool(connectionString, "teams/0001", SCHEMA);
  const enabled = () => flags.enabled("team_scopes", orgScope);
  return {
    async list() {
      if (!(await enabled())) return [];
      const rows = await q(
        `SELECT t.team_id, t.name, t.isolated_in_open,
           (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.team_id) AS member_count,
           COALESCE((SELECT array_agg(r.scope_id ORDER BY r.scope_id) FROM team_rooms r WHERE r.team_id = t.team_id), '{}') AS rooms
         FROM teams t ORDER BY t.team_id`,
      );
      return rows.map((r) => ({
        id: r.team_id as string,
        name: r.name as string,
        isolatedInOpen: r.isolated_in_open as boolean,
        rooms: r.rooms as ScopeId[],
        memberCount: r.member_count as number,
      }));
    },
    async forTurn(scope, principalIds) {
      if (!(await enabled())) return [];
      const rows = await q(
        `SELECT t.team_id, t.name, t.isolated_in_open,
           EXISTS (SELECT 1 FROM team_rooms r WHERE r.team_id = t.team_id AND r.scope_id = $1) AS configured,
           array_agg(m.principal_id) AS present
         FROM team_members m JOIN teams t ON t.team_id = m.team_id
         WHERE m.principal_id = ANY($2)
         GROUP BY t.team_id ORDER BY t.team_id`,
        [scope, [...new Set(principalIds.flatMap(keysOf))]],
      );
      return rows.map((r) => ({
        id: r.team_id as string,
        name: r.name as string,
        isolatedInOpen: r.isolated_in_open as boolean,
        configured: r.configured as boolean,
        present: new Set(r.present as string[]),
      }));
    },
    async isMember(principalId, teamId) {
      if (!(await enabled())) return false;
      const rows = await q("SELECT 1 FROM team_members WHERE team_id = $1 AND principal_id = ANY($2) LIMIT 1", [
        teamId,
        keysOf(principalId),
      ]);
      return rows.length > 0;
    },
    async apply(c, actorId) {
      const now = Date.now();
      await withPgTransaction(await pool(), async (db) => {
        if (c.remove) {
          await db.query("DELETE FROM teams WHERE team_id = $1", [c.id]);
          return;
        }
        await db.query(
          `INSERT INTO teams (team_id, name, isolated_in_open, created_by, created_at)
           VALUES ($1, COALESCE($2, $1), COALESCE($3, FALSE), $4, $5)
           ON CONFLICT (team_id) DO UPDATE SET
             name = COALESCE($2, teams.name),
             isolated_in_open = COALESCE($3, teams.isolated_in_open)`,
          [c.id, c.name ?? null, c.isolatedInOpen ?? null, actorId, now],
        );
        const people = [
          ...(c.addMembers ?? []).map((p) => [personKey(p), "member"]),
          ...(c.addAdmins ?? []).map((p) => [personKey(p), "admin"]),
        ];
        if (people.length)
          await db.query(
            `INSERT INTO team_members (team_id, principal_id, role, added_by, added_at)
             SELECT $1, p, r, $4, $5 FROM unnest($2::text[], $3::text[]) AS x(p, r)
             ON CONFLICT (team_id, principal_id) DO UPDATE SET role = EXCLUDED.role`,
            [c.id, people.map(([p]) => p), people.map(([, r]) => r), actorId, now],
          );
        if (c.drop?.length)
          await db.query("DELETE FROM team_members WHERE team_id = $1 AND principal_id = ANY($2)", [
            c.id,
            c.drop.map(personKey),
          ]);
        if (c.addRooms?.length)
          await db.query(
            "INSERT INTO team_rooms (team_id, scope_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING",
            [c.id, c.addRooms],
          );
        if (c.dropRooms?.length)
          await db.query("DELETE FROM team_rooms WHERE team_id = $1 AND scope_id = ANY($2)", [c.id, c.dropRooms]);
      });
    },
  };
}

export function teamsForTurn(
  teams: readonly TurnTeam[],
  turn: { scope: ScopeId; actorId: string; audience: readonly Principal[]; posture: SharingPosture },
): { teamIds: string[]; note?: string } {
  const ownScope = turn.scope === scopeId("personal", turn.actorId);
  const everyoneOn = (t: TurnTeam) => turn.audience.length > 0 && turn.audience.every((p) => onTeam(t, p.id));
  const applies = teams.filter(
    (t) =>
      onTeam(t, turn.actorId) &&
      (ownScope || t.configured || everyoneOn(t) || (turn.posture === "open" && !t.isolatedInOpen)),
  );
  const teamIds = applies.map((t) => t.id);
  if (teamIds.length < 2) return { teamIds };
  const configured = applies.filter((t) => t.configured).length;
  const label = (t: TurnTeam) => `team:${t.id} (${t.name})${t.configured ? " — configured for this room" : ""}`;
  return {
    teamIds,
    note: [
      `Team scopes available in this turn: ${applies.map(label).join(", ")}.`,
      configured === 1
        ? "If two teams provide a credential or resource with the same name, use the team configured for this room."
        : "If two teams provide a credential or resource with the same name, ask which team to use before acting.",
    ].join(" "),
  };
}

export async function scopeTeamsToTurn<
  T extends { actor: Principal; conversation: Conversation; conversationHeader?: string },
>(
  input: T,
  deps: {
    teams?: TeamStore;
    config?: { resolveSharingPostureDurable(personalId: ScopeId, targetId: ScopeId): Promise<SharingPosture> };
  },
  external: boolean,
): Promise<T> {
  if (external || !deps.teams) return input;
  const { actor, conversation } = input;
  const scope = conversationScope(conversation, actor.id);
  const rows = await deps.teams.forTurn(scope, [actor.id, ...conversation.audience.map((p) => p.id)]);
  if (!rows.length) return input;
  const posture = (await deps.config?.resolveSharingPostureDurable(scopeId("personal", actor.id), scope)) ?? "isolated";
  const { teamIds, note } = teamsForTurn(rows, { scope, actorId: actor.id, audience: conversation.audience, posture });
  if (!teamIds.length) return input;
  const stamp = (p: Principal): Principal => {
    const own = rows.filter((t) => teamIds.includes(t.id) && onTeam(t, p.id)).map((t) => t.id);
    return p.type === "internal" && own.length ? { ...p, teamIds: [...new Set([...(p.teamIds ?? []), ...own])] } : p;
  };
  const header = [input.conversationHeader?.trim(), note].filter(Boolean).join("\n\n");
  return {
    ...input,
    actor: stamp(actor),
    conversation: { ...conversation, audience: conversation.audience.map(stamp), teamIds },
    ...(header ? { conversationHeader: header } : {}),
  };
}
