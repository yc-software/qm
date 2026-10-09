import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeTeamsToTurn, teamsForTurn, type TeamStore, type TurnTeam } from "../src/teams/teams.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { scopeId, type Conversation, type Principal, type ScopeId } from "../src/types.ts";

const person = (id: string): Principal => ({ id, type: "internal" }) as Principal;
const team = (over: Partial<TurnTeam> = {}): TurnTeam => ({
  id: "finance",
  name: "Finance",
  isolatedInOpen: false,
  configured: false,
  present: new Set(["ann@x.com", "bo@x.com"]),
  ...over,
});
const turn = (
  scope: ScopeId,
  audience: string[],
  posture: "open" | "isolated" = "isolated",
  actorId = "ann@x.com",
) => ({
  scope,
  actorId,
  audience: audience.map(person),
  posture,
});
const room = scopeId("channel", "C1");

test("isolated: a member's own DM gets the team", () => {
  assert.deepEqual(teamsForTurn([team()], turn(scopeId("personal", "ann@x.com"), ["ann@x.com"])).teamIds, ["finance"]);
});

test("isolated: a room qualifies only while everyone present is on the team", () => {
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "bo@x.com"])).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "bo@x.com", "cy@x.com"])).teamIds, []);
});

test("isolated: configured rooms keep the team for members when a non-member joins", () => {
  const t = team({ configured: true });
  assert.deepEqual(teamsForTurn([t], turn(room, ["ann@x.com", "cy@x.com"])).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([t], turn(room, ["ann@x.com", "cy@x.com"], "isolated", "cy@x.com")).teamIds, []);
});

test("open: available wherever a member speaks unless the team opts out", () => {
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "cy@x.com"], "open")).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "cy@x.com"], "open", "cy@x.com")).teamIds, []);
  assert.deepEqual(
    teamsForTurn([team({ isolatedInOpen: true })], turn(room, ["ann@x.com", "cy@x.com"], "open")).teamIds,
    [],
  );
});

test("multiple teams all apply; the note names the configured room's team or asks", () => {
  const b = team({ id: "legal", name: "Legal" });
  const asked = teamsForTurn([team(), b], turn(room, ["ann@x.com", "bo@x.com"]));
  assert.deepEqual(asked.teamIds, ["finance", "legal"]);
  assert.match(asked.note!, /ask which team/);
  const preferred = teamsForTurn([team(), { ...b, configured: true }], turn(room, ["ann@x.com", "bo@x.com"]));
  assert.match(preferred.note!, /team:legal \(Legal\) — configured for this room/);
  assert.match(preferred.note!, /use the team configured for this room/);
});

const fakeStore = (teams: TurnTeam[]): TeamStore => ({
  list: async () => [],
  forTurn: async (_scope, ids) => teams.filter((t) => ids.some((id) => t.present.has(id.toLowerCase()))),
  isMember: async (id, teamId) => teams.some((t) => t.id === teamId && t.present.has(id.toLowerCase())),
  apply: async () => {},
});
const group = (audience: Principal[]) =>
  ({ kind: "group", channelRef: "G1", threadRef: "t", audience }) as unknown as Conversation;
const isolated = { resolveSharingPostureDurable: async () => "isolated" as const };
const open = { resolveSharingPostureDurable: async () => "open" as const };

test("scopeTeamsToTurn stamps teams only onto members and keeps their existing team ids", async () => {
  const teams = fakeStore([team()]);
  const out = await scopeTeamsToTurn(
    {
      actor: { ...person("ann@x.com"), teamIds: ["legacy"] },
      conversation: group([person("ann@x.com"), person("bo@x.com")]),
    },
    { teams, config: isolated },
    false,
  );
  assert.deepEqual(out.actor.teamIds, ["legacy", "finance"]);
  assert.deepEqual(out.conversation.teamIds, ["finance"]);
  assert.deepEqual(
    out.conversation.audience.map((p) => p.teamIds),
    [["finance"], ["finance"]],
  );

  const guest = { id: "g@y.com", type: "guest" } as Principal;
  const mixed = await scopeTeamsToTurn(
    { actor: person("ann@x.com"), conversation: group([person("ann@x.com"), person("cy@x.com"), guest]) },
    { teams, config: open },
    false,
  );
  assert.deepEqual(
    mixed.conversation.audience.map((p) => p.teamIds),
    [["finance"], undefined, undefined],
  );
});

test("scopeTeamsToTurn leaves the turn untouched when no team applies or the turn is external", async () => {
  const teams = fakeStore([team()]);
  const input = { actor: person("ann@x.com"), conversation: group([person("ann@x.com"), person("cy@x.com")]) };
  assert.equal(await scopeTeamsToTurn(input, { teams, config: isolated }, false), input);
  assert.equal(await scopeTeamsToTurn(input, { teams, config: open }, true), input);
});

test("team scope read and write follow team membership", async () => {
  const teams = fakeStore([team()]);
  const identity = { classify: () => ({ type: "internal" }) };
  assert.equal(await createCanReadScope({ identity, teams })("bo@x.com", scopeId("team", "finance")), true);
  assert.equal(await createCanWriteScope({ identity, teams })("bo@x.com", scopeId("team", "finance")), true);
  assert.equal(await createCanReadScope({ identity, teams })("cy@x.com", scopeId("team", "finance")), false);
});
