import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { createCanReadScope, createCanWriteScope } from "../../src/resolution/scope-membership.ts";
import {
  scopeTeamsToTurn,
  teamsForTurn,
  type TeamStore,
  type TurnTeam,
  createPostgresTeamStore,
} from "../../src/teams/teams.ts";
import { scopeId, type Conversation, type Principal, type ScopeId } from "../../src/types.ts";
import { truncateTables } from "../support/test-database.ts";

const person = (id: string): Principal => ({ id, type: "internal" }) as Principal;
const team = (over: Partial<TurnTeam> = {}): TurnTeam => ({
  id: "finance",
  name: "Finance",
  isolatedInOpen: false,
  configured: false,
  present: new Set(["ann@x.com", "bo@x.com"]),
  ...over,
});
const turn = (scope: ScopeId, audience: string[], actorId = "ann@x.com") => ({
  scope,
  actorId,
  audience: audience.map(person),
});
const room = scopeId("channel", "C1");
const optedOut = (over: Partial<TurnTeam> = {}) => team({ isolatedInOpen: true, ...over });

test("a member's own DM gets the team", () => {
  assert.deepEqual(teamsForTurn([optedOut()], turn(scopeId("personal", "ann@x.com"), ["ann@x.com"])).teamIds, [
    "finance",
  ]);
});

test("an opted-out team qualifies in a room only while everyone present is on the team", () => {
  assert.deepEqual(teamsForTurn([optedOut()], turn(room, ["ann@x.com", "bo@x.com"])).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([optedOut()], turn(room, ["ann@x.com", "bo@x.com", "cy@x.com"])).teamIds, []);
});

test("configured rooms keep an opted-out team for members when a non-member joins", () => {
  const t = optedOut({ configured: true });
  assert.deepEqual(teamsForTurn([t], turn(room, ["ann@x.com", "cy@x.com"])).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([t], turn(room, ["ann@x.com", "cy@x.com"], "cy@x.com")).teamIds, []);
});

test("a team is available wherever a member speaks unless the team opts out", () => {
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "cy@x.com"])).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "cy@x.com"], "cy@x.com")).teamIds, []);
  assert.deepEqual(teamsForTurn([optedOut()], turn(room, ["ann@x.com", "cy@x.com"])).teamIds, []);
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

test("scopeTeamsToTurn stamps teams only onto members and keeps their existing team ids", async () => {
  const teams = fakeStore([team()]);
  const out = await scopeTeamsToTurn(
    {
      actor: { ...person("ann@x.com"), teamIds: ["legacy"] },
      conversation: group([person("ann@x.com"), person("bo@x.com")]),
    },
    { teams },
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
    { teams },
    false,
  );
  assert.deepEqual(
    mixed.conversation.audience.map((p) => p.teamIds),
    [["finance"], undefined, undefined],
  );
});

test("scopeTeamsToTurn leaves the turn untouched when no team applies or the turn is external", async () => {
  const teams = fakeStore([optedOut()]);
  const input = { actor: person("ann@x.com"), conversation: group([person("ann@x.com"), person("cy@x.com")]) };
  assert.equal(await scopeTeamsToTurn(input, { teams }, false), input);
  assert.equal(await scopeTeamsToTurn(input, { teams: fakeStore([team()]) }, true), input);
});

test("team scope read and write follow team membership", async () => {
  const teams = fakeStore([team()]);
  const identity = { classify: () => ({ type: "internal" }) };
  assert.equal(await createCanReadScope({ identity, teams })("bo@x.com", scopeId("team", "finance")), true);
  assert.equal(await createCanWriteScope({ identity, teams })("bo@x.com", scopeId("team", "finance")), true);
  assert.equal(await createCanReadScope({ identity, teams })("cy@x.com", scopeId("team", "finance")), false);
});

const URL = process.env.DATABASE_URL!;

beforeEach(async () => {
  await truncateTables(URL, ["team_rooms", "team_members", "teams"]);
});

const store = (on = true) => createPostgresTeamStore(URL, { enabled: async () => on });

test("pg teams: members are rows, edited one at a time, looked up by person", async () => {
  const teams = store();
  const members = Array.from({ length: 1000 }, (_, i) => `p${i}@x.com`);
  await teams.apply(
    { id: "finance", name: "Finance", addMembers: members, addAdmins: ["Boss@X.com"], addRooms: [room] },
    "a",
  );
  await teams.apply({ id: "legal", addMembers: ["p1@x.com"] }, "a");

  const [finance] = await teams.list();
  assert.equal(finance!.memberCount, 1001);
  assert.deepEqual(finance!.rooms, [room]);

  assert.equal(await teams.isMember("boss@x.com", "finance"), true);
  await teams.apply({ id: "finance", drop: ["p0@x.com"] }, "a");
  assert.equal(await teams.isMember("p0@x.com", "finance"), false);
  assert.equal((await teams.list())[0]!.memberCount, 1000);

  const turn = await teams.forTurn(room, ["p1@x.com", "outsider@x.com"]);
  assert.deepEqual(
    turn.map((t) => [t.id, t.configured, [...t.present]]),
    [
      ["finance", true, ["p1@x.com"]],
      ["legal", false, ["p1@x.com"]],
    ],
  );
});

test("pg teams: removing a team removes its members and rooms", async () => {
  const teams = store();
  await teams.apply({ id: "finance", addMembers: ["ann@x.com"], addRooms: [room] }, "a");
  await teams.apply({ id: "finance", remove: true }, "a");
  assert.deepEqual(await teams.list(), []);
  assert.deepEqual(await teams.forTurn(room, ["ann@x.com"]), []);
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  const { rows } = await p.query(
    "SELECT (SELECT count(*) FROM team_members)::int + (SELECT count(*) FROM team_rooms)::int AS n",
  );
  await p.end();
  assert.equal(rows[0].n, 0);
});

test("pg teams: the feature flag gates every read", async () => {
  await store().apply({ id: "finance", addMembers: ["ann@x.com"] }, "a");
  const off = store(false);
  assert.deepEqual(await off.list(), []);
  assert.deepEqual(await off.forTurn(room, ["ann@x.com"]), []);
  assert.equal(await off.isMember("ann@x.com", "finance"), false);
});
