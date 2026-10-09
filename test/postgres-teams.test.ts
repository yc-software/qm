import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresTeamStore } from "../src/teams/teams.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres team tests";
const org = scopeId("org", "default-org");
const room = scopeId("channel", "C1");

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations, team_rooms, team_members, teams CASCADE");
  await p.end();
});

const store = (on = true) => createPostgresTeamStore(URL!, { enabled: async () => on }, org);

test("pg teams: members are rows, edited one at a time, looked up by person", { skip }, async () => {
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

test("pg teams: removing a team removes its members and rooms", { skip }, async () => {
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

test("pg teams: the feature flag gates every read", { skip }, async () => {
  await store().apply({ id: "finance", addMembers: ["ann@x.com"] }, "a");
  const off = store(false);
  assert.deepEqual(await off.list(), []);
  assert.deepEqual(await off.forTurn(room, ["ann@x.com"]), []);
  assert.equal(await off.isMember("ann@x.com", "finance"), false);
});
