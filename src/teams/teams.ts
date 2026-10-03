import type { DurableMap } from "../persistence/durable-map.ts";
import { samePerson } from "../directory/person.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { SharingPosture } from "../resolution/sharing-posture.ts";
import type { Conversation, Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";

export interface TeamRecord {
  id: string;
  name: string;
  members: string[];
  admins: string[];
  rooms: ScopeId[];
  isolatedInOpen: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface TeamStore {
  list(): Promise<TeamRecord[]>;
  isMember(principalId: string, teamId: string): Promise<boolean>;
  put(team: TeamRecord): Promise<void>;
  remove(teamId: string): Promise<void>;
}

const onTeam = (team: TeamRecord, principalId: string) =>
  [...team.members, ...team.admins].some((m) => samePerson(m, principalId));

export function createTeamStore(
  backing: DurableMap<TeamRecord>,
  flags: Pick<FeatureFlagStore, "enabled">,
  orgScope: ScopeId,
): TeamStore {
  const enabled = () => flags.enabled("team_scopes", orgScope);
  return {
    list: async () => ((await enabled()) ? backing.all() : []),
    async isMember(principalId, teamId) {
      if (!(await enabled())) return false;
      const team = await backing.get(teamId);
      return !!team && onTeam(team, principalId);
    },
    put: (team) => backing.put(team.id, team),
    remove: (teamId) => backing.delete(teamId),
  };
}

interface TurnTeams {
  teamIds: string[];
  note?: string;
}

export function teamsForTurn(
  teams: readonly TeamRecord[],
  turn: { scope: ScopeId; actorId: string; audience: readonly Principal[]; posture: SharingPosture },
): TurnTeams {
  const ownScope = turn.scope === scopeId("personal", turn.actorId);
  const everyoneOn = (team: TeamRecord) => turn.audience.length > 0 && turn.audience.every((p) => onTeam(team, p.id));
  const configured = teams.filter((t) => t.rooms.includes(turn.scope));
  const applies = teams.filter(
    (t) =>
      configured.includes(t) ||
      (onTeam(t, turn.actorId) && (ownScope || everyoneOn(t) || (turn.posture === "open" && !t.isolatedInOpen))),
  );
  const teamIds = applies.map((t) => t.id);
  if (teamIds.length < 2) return { teamIds };
  const label = (t: TeamRecord) =>
    `team:${t.id} (${t.name})${configured.includes(t) ? " — configured for this room" : ""}`;
  return {
    teamIds,
    note: [
      `Team scopes available in this turn: ${applies.map(label).join(", ")}.`,
      configured.length === 1
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
  const teams = external ? [] : ((await deps.teams?.list()) ?? []);
  if (!teams.length) return input;
  const scope = conversationScope(input.conversation, input.actor.id);
  const posture = teams.length
    ? ((await deps.config?.resolveSharingPostureDurable(scopeId("personal", input.actor.id), scope)) ?? "isolated")
    : "isolated";
  const { teamIds, note } = teamsForTurn(teams, {
    scope,
    actorId: input.actor.id,
    audience: input.conversation.audience,
    posture,
  });
  const stamp = ({ teamIds: _, ...p }: Principal): Principal =>
    p.type === "internal" && teamIds.length ? { ...p, teamIds } : p;
  const header = [input.conversationHeader?.trim(), note].filter(Boolean).join("\n\n");
  return {
    ...input,
    actor: stamp(input.actor),
    conversation: { ...input.conversation, audience: input.conversation.audience.map(stamp), teamScoped: true },
    ...(header ? { conversationHeader: header } : {}),
  };
}
