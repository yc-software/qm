import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { buildApp } from "./support/build-app.ts";
import { scopeId, type Cron } from "../src/types.ts";
import { bill } from "./support/spend-usage.ts";
import { testConfig } from "./support/test-config.ts";

const DAY = 86_400_000;
const today = new Date(Math.floor(Date.now() / DAY) * DAY).toISOString().slice(0, 10);
const tomorrow = new Date(Math.floor(Date.now() / DAY) * DAY + DAY).toISOString().slice(0, 10);
const WINDOW = `from=${today}&to=${tomorrow}`;

async function start(options: { sessions?: false } = {}) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "self-spend-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: options.sessions === false ? undefined : built.sessions,
    auditLog: built.auditLog,
    runs: built.runs,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await built.app.upsertDirectory([
    { principalId: "alice", displayName: "Alice", type: "internal" },
    { principalId: "bob", displayName: "Bob", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [
      { channelId: "C1", name: "general", isPrivate: false },
      { channelId: "P1", name: "bobs-room", isPrivate: true },
      { channelId: "P2", name: "alices-room", isPrivate: true },
    ],
    [
      { channelId: "P1", principalId: "bob" },
      { channelId: "P2", principalId: "alice" },
    ],
  );
  const cron = (owner: string, ownerScopeId: string, extra: Partial<Cron> = {}) =>
    built.app.createCron({
      title: `${owner} ${ownerScopeId}`,
      action: "tick",
      schedule: { everyMs: 3_600_000 },
      owner,
      createdBy: owner,
      ownerScopeId: ownerScopeId as Cron["ownerScopeId"],
      ...extra,
    });
  return {
    base,
    built,
    cron,
    mine: (query = WINDOW) => fetch(`${base}/v1/spend?principalId=alice&${query}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("self spend: your personal scope plus the shared scopes you can see, nothing else", async () => {
  const s = await start();
  try {
    const sessions = s.built.sessions;
    await bill(sessions, "dm:alice:t1", "dm", scopeId("personal", "alice"), { costUsd: 2 });
    await bill(sessions, "dm:bob:t1", "dm", scopeId("personal", "bob"), { costUsd: 1.25 });
    await bill(sessions, "ch:C1:t1", "channel", scopeId("channel", "C1"), { costUsd: 3 });
    await bill(sessions, "ch:P1:t1", "channel", scopeId("channel", "P1"), { costUsd: 4 });
    await bill(sessions, "ch:P2:t1", "channel", scopeId("channel", "P2"), { costUsd: 5 });
    const project = (await s.built.app.createProject("alice", "Launch"))!;
    await bill(sessions, "web:alice:launch", "group", project.scopeId, { costUsd: 6 });
    await s.built.app.upsertGroups([
      { groupId: "G1", principalId: "alice" },
      { groupId: "G1", principalId: "bob" },
      { groupId: "G2", principalId: "bob" },
    ]);
    for (const [group, costUsd] of [
      ["G1", 7],
      ["G2", 8],
    ] as const) {
      await bill(sessions, `grp:${group}:t1`, "group", scopeId("group", group), { costUsd });
      const session = await sessions.getOrCreateByThread(`grp:${group}:t1`, "group", scopeId("group", group));
      await sessions.addParticipant(session.id, "alice");
    }

    const response = await s.mine();
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.scopeId, "personal:alice");
    assert.deepEqual(
      body.people.map((p: any) => [p.principalId, p.costUsd]),
      [["alice", 2]],
    );
    assert.deepEqual(
      body.scopes.map((e: any) => [e.scopeId, e.displayName, e.costUsd]),
      [
        ["group:G1", "", 7],
        [project.scopeId, "Launch", 6],
        ["channel:P2", "alices-room", 5],
        ["channel:C1", "general", 3],
      ],
      "a group DM you posted in but have since left is not yours to see",
    );
    assert.equal(body.org.costUsd, 23);
    assert.deepEqual(
      body.series.flatMap((p: any) => p.people.map((x: any) => x.principalId)),
      ["alice", null],
      "the series never names anyone but the viewer",
    );

    const admin = (await (
      await fetch(`${s.base}/v1/admin/spend?${WINDOW}`, { headers: { "x-admin-actor": "admin-alice@default-org" } })
    ).json()) as any;
    const totals = ({ displayName: _name, ...row }: any) => row;
    assert.deepEqual(
      totals(body.people[0]),
      totals(admin.people.find((p: any) => p.principalId === "alice")),
      "your row matches the admin page's row for you",
    );
    assert.equal(
      (await s.built.auditLog.events()).filter((e) => e.action === "spend.self.read" && e.principalId === "alice")
        .length,
      1,
    );
  } finally {
    await s.close();
  }
});

test("self spend: your crons are split from the crons others made that you can see", async (t) => {
  const s = await start();
  try {
    const sessions = s.built.sessions;
    const yours = await s.cron("alice", "personal:alice");
    const yoursInChannel = await s.cron("alice", "channel:C1");
    const shared = await s.cron("bob", "channel:C1");
    const toYou = await s.cron("bob", "personal:bob", {
      destination: { type: "principal", target: "alice", audienceScopeId: "personal:alice" },
    });
    const bobsOwn = await s.cron("bob", "personal:bob");
    const bobsPrivate = await s.cron("bob", "channel:P1");
    const bobsGroup = await s.cron("bob", "group:G1");
    t.after(async () => {
      for (const cron of [yours, yoursInChannel, shared, toYou, bobsOwn, bobsPrivate, bobsGroup])
        await s.built.app.deleteCron(cron.id);
    });
    await s.built.app.upsertGroups([
      { groupId: "G1", principalId: "alice" },
      { groupId: "G1", principalId: "bob" },
    ]);
    const fire = (cron: Cron, scope: string, type: "dm" | "channel" | "group", costUsd: number) =>
      bill(sessions, `cron:${cron.id}:fire:abc123`, type, scope, { costUsd });
    await fire(yours, "personal:alice", "dm", 0.5);
    await fire(yoursInChannel, "channel:C1", "channel", 0.75);
    await fire(shared, "channel:C1", "channel", 1);
    await fire(toYou, "personal:bob", "dm", 2);
    await fire(bobsOwn, "personal:bob", "dm", 4);
    await fire(bobsPrivate, "channel:P1", "channel", 8);
    await bill(sessions, "cron:gone:fire:abc123", "dm", "personal:alice", { costUsd: 0.25 });
    await fire(bobsGroup, "group:G1", "group", 0.125);
    const groupFire = await sessions.getOrCreateByThread(`cron:${bobsGroup.id}:fire:abc123`, "group", "group:G1");
    await sessions.addParticipant(groupFire.id, "alice");

    const body = (await (await s.mine()).json()) as any;
    assert.deepEqual(
      body.crons.map((c: any) => [c.cronId, c.owned, c.costUsd, c.info?.title ?? null]),
      [
        [shared.id, false, 1, "bob channel:C1"],
        [yoursInChannel.id, true, 0.75, "alice channel:C1"],
        [yours.id, true, 0.5, "alice personal:alice"],
        ["gone", false, 0.25, null],
        [bobsGroup.id, false, 0.125, null],
      ],
      "a cron you can see but that spends in its owner's own space is not listed, and one you cannot open keeps its cost without details",
    );
    assert.equal(body.org.costUsd, 2.625);
    assert.deepEqual(
      body.people.map((p: any) => p.principalId),
      ["alice"],
    );
  } finally {
    await s.close();
  }
});

test("self spend: a linked sign-in's personal spend is yours", async (t) => {
  const s = await start();
  installPrincipalLinks({ canonical: (id) => (id === "slack-alice" ? "alice" : undefined), aliases: () => [] });
  t.after(() => installPrincipalLinks(null));
  try {
    await bill(s.built.sessions, "dm:alice:t1", "dm", scopeId("personal", "alice"), { costUsd: 2 });
    await bill(s.built.sessions, "dm:slack-alice:t1", "dm", scopeId("personal", "slack-alice"), { costUsd: 3 });
    const body = (await (await s.mine()).json()) as any;
    assert.deepEqual(
      body.people.map((p: any) => [p.principalId, p.costUsd]),
      [["alice", 5]],
    );
  } finally {
    await s.close();
  }
});

test("self spend: rejects a window over 93 days, an unknown bucket and a missing principal", async () => {
  const s = await start();
  try {
    const status = async (query: string) => (await s.mine(query)).status;
    assert.equal(await status("from=2026-01-01&to=2026-04-05"), 400);
    assert.equal(await status("from=2026-01-01&to=2026-04-04"), 200);
    assert.equal(await status(`${WINDOW}&bucket=month`), 400);
    assert.equal(await status(`${WINDOW}&bucket=week`), 200);
    assert.equal((await fetch(`${s.base}/v1/spend?${WINDOW}`)).status, 400);
  } finally {
    await s.close();
  }
});

test("self spend: answers 503 without a session store", async () => {
  const s = await start({ sessions: false });
  try {
    const response = await s.mine();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "spend_unavailable" });
  } finally {
    await s.close();
  }
});
