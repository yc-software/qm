import { test } from "node:test";
import assert from "node:assert/strict";
import { createTeamStore, scopeTeamsToTurn, teamsForTurn, type TeamRecord } from "../src/teams/teams.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { createFeatureFlagStore, type FeatureFlagRecord } from "../src/feature-flags.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Conversation, type Principal, type ScopeId } from "../src/types.ts";

const person = (id: string): Principal => ({ id, type: "internal" }) as Principal;
const team = (over: Partial<TeamRecord> = {}): TeamRecord => ({
  id: "finance",
  name: "Finance",
  members: ["ann@x.com", "bo@x.com"],
  admins: [],
  rooms: [],
  isolatedInOpen: false,
  updatedAt: 0,
  updatedBy: "admin@x.com",
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

test("isolated: a member's own DM gets the team", () => {
  assert.deepEqual(teamsForTurn([team()], turn(scopeId("personal", "ann@x.com"), ["ann@x.com"])).teamIds, ["finance"]);
});

test("isolated: a room qualifies only while everyone present is on the team", () => {
  const room = scopeId("channel", "C1");
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "bo@x.com"])).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "bo@x.com", "cy@x.com"])).teamIds, []);
});

test("isolated: configured rooms keep the team when a non-member joins", () => {
  const room = scopeId("channel", "C1");
  const t = team({ rooms: [room] });
  assert.deepEqual(teamsForTurn([t], turn(room, ["ann@x.com", "cy@x.com"])).teamIds, ["finance"]);
});

test("open: available wherever a member speaks unless the team opts out", () => {
  const room = scopeId("channel", "C1");
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "cy@x.com"], "open")).teamIds, ["finance"]);
  assert.deepEqual(teamsForTurn([team()], turn(room, ["ann@x.com", "cy@x.com"], "open", "cy@x.com")).teamIds, []);
  assert.deepEqual(
    teamsForTurn([team({ isolatedInOpen: true })], turn(room, ["ann@x.com", "cy@x.com"], "open")).teamIds,
    [],
  );
});

test("multiple teams all apply; the note names the configured room's team or asks", () => {
  const room = scopeId("channel", "C1");
  const a = team();
  const b = team({ id: "legal", name: "Legal" });
  const asked = teamsForTurn([a, b], turn(room, ["ann@x.com", "bo@x.com"]));
  assert.deepEqual(asked.teamIds, ["finance", "legal"]);
  assert.match(asked.note!, /ask which team/);
  const preferred = teamsForTurn([a, { ...b, rooms: [room] }], turn(room, ["ann@x.com", "bo@x.com"]));
  assert.match(preferred.note!, /team:legal \(Legal\) — configured for this room/);
  assert.match(preferred.note!, /use the team configured for this room/);
});

async function flaggedStore(on: boolean) {
  const flags = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
  const org = scopeId("org", "default-org");
  if (on) await flags.setEnabled("team_scopes", org, true, "admin@x.com");
  const backing = createMemoryMap<TeamRecord>();
  const store = createTeamStore(backing, flags, org);
  await store.put(team());
  return store;
}

test("the feature flag gates every read; default off", async () => {
  const off = await flaggedStore(false);
  assert.deepEqual(await off.list(), []);
  assert.equal(await off.isMember("ann@x.com", "finance"), false);
  const on = await flaggedStore(true);
  assert.equal((await on.list()).length, 1);
  assert.equal(await on.isMember("ANN@x.com", "finance"), true);
});

test("scopeTeamsToTurn stamps the turn's teams onto the actor and audience", async () => {
  const teams = await flaggedStore(true);
  const conversation = {
    kind: "group",
    channelRef: "G1",
    threadRef: "t",
    audience: [person("ann@x.com"), person("bo@x.com")],
  } as unknown as Conversation;
  const config = { resolveSharingPostureDurable: async () => "isolated" as const };
  const out = await scopeTeamsToTurn({ actor: person("ann@x.com"), conversation }, { teams, config }, false);
  assert.deepEqual(out.actor.teamIds, ["finance"]);
  assert.deepEqual(
    out.conversation.audience.map((p) => p.teamIds),
    [["finance"], ["finance"]],
  );
  const guest = { id: "g@y.com", type: "guest" } as Principal;
  const mixed = await scopeTeamsToTurn(
    { actor: person("ann@x.com"), conversation: { ...conversation, audience: [person("ann@x.com"), guest] } },
    { teams, config: { resolveSharingPostureDurable: async () => "open" as const } },
    false,
  );
  assert.deepEqual(
    mixed.conversation.audience.map((p) => p.teamIds),
    [["finance"], undefined],
  );
  const external = await scopeTeamsToTurn({ actor: person("ann@x.com"), conversation }, { teams, config }, true);
  assert.equal(external.actor.teamIds, undefined);
  assert.equal(external.conversation.teamScoped, undefined);
  assert.equal(out.conversation.teamScoped, true);
  const asserted = { ...person("ann@x.com"), teamIds: ["legacy"] };
  const replaced = await scopeTeamsToTurn({ actor: asserted, conversation }, { teams, config }, false);
  assert.deepEqual(replaced.actor.teamIds, ["finance"]);
});

test("team scope read and write follow team membership", async () => {
  const teams = await flaggedStore(true);
  const identity = { classify: () => ({ type: "internal" }) };
  const canRead = createCanReadScope({ identity, teams });
  const canWrite = createCanWriteScope({ identity, teams });
  assert.equal(await canRead("bo@x.com", scopeId("team", "finance")), true);
  assert.equal(await canWrite("bo@x.com", scopeId("team", "finance")), true);
  assert.equal(await canRead("cy@x.com", scopeId("team", "finance")), false);
});
