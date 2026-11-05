import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { gatewayActorId } from "../src/model/provider-endpoints.ts";
import { buildApp } from "./support/build-app.ts";
import { computeUsers } from "../src/admin/users.ts";
import { USER_MIGRATIONS } from "../src/identity/user-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("computeUsers dedupes participants, credits their turns, and joins admin status", () => {
  const participants = [
    { sessionId: "s1", principalId: "U1" },
    { sessionId: "s2", principalId: "U1" },
    { sessionId: "s1", principalId: "U2" },
  ];
  const turns = [
    { principalId: "U1", sessionId: "s1", day: 0, turns: 2, firstAt: 150, lastAt: 160 },
    { principalId: "U2", sessionId: "s1", day: 0, turns: 2, firstAt: 150, lastAt: 160 },
    { principalId: "U1", sessionId: "s2", day: 0, turns: 1, firstAt: 250, lastAt: 250 },
  ];
  const grants = [{ principalId: "U2", scopeId: "org:default-org", role: "org_admin" as const }];
  const rows = computeUsers({ participants, turns, grants, people: ["U1", "U2"] });
  const byId: Record<string, any> = Object.fromEntries(rows.map((r) => [r.principalId, r]));

  assert.equal(byId.U1.sessionCount, 2);
  assert.equal(byId.U1.turnCount, 3);
  assert.equal(byId.U1.lastSeenAt, 250);
  assert.deepEqual(byId.U1.admin, { isAdmin: false });
  assert.equal(byId.U2.admin.role, "org_admin");
  assert.equal(rows[0]!.principalId, "U2");
});

test("computeUsers sums a participant's turn rollup and takes its latest timestamp", () => {
  const rows = computeUsers({
    participants: [{ sessionId: "s1", principalId: "U1" }],
    turns: [{ principalId: "U1", sessionId: "s1", day: 0, turns: 2, firstAt: 100, lastAt: 199 }],
    grants: [],
    people: ["U1"],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.turnCount, 2, "the participant's two turns");
  assert.equal(rows[0]!.lastSeenAt, 199);
});

test("computeUsers lists exactly the roster: a quiet admin gets a row, a participant who is not on it does not", () => {
  const rows = computeUsers({
    participants: [{ sessionId: "s1", principalId: "U9" }],
    turns: [],
    grants: [{ principalId: "ghost-admin", scopeId: "org:default-org", role: "org_admin" as const }],
    people: ["ghost-admin"],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.principalId, "ghost-admin");
  assert.equal(rows[0]!.sessionCount, 0);
  assert.equal(rows[0]!.lastSeenAt, null);
  assert.equal(rows[0]!.admin.isAdmin, true);
});

test("computeUsers credits activity to a roster person whatever the case of their id", () => {
  const rows = computeUsers({
    participants: [
      {
        sessionId: "s1",
        principalId: "Pat@Example.com",
      },
    ],
    turns: [{ principalId: "Pat@Example.com", sessionId: "s1", day: 0, turns: 3, firstAt: 100, lastAt: 150 }],
    grants: [],
    people: ["pat@example.com"],
  });
  assert.deepEqual(
    rows.map((r) => [r.principalId, r.sessionCount, r.turnCount, r.lastSeenAt]),
    [["pat@example.com", 1, 3, 150]],
  );
});

function start(extra: Partial<ServerDeps> = {}) {
  const databaseUrl = testMigratedDatabaseUrl();
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-users-")), databaseUrl }));
  const server = createInsecureTestServer(built.app, {
    ...extra,
    admin: built.admin,
    identity: built.identity,
    sessions: built.sessions,
    files: built.files,
    directory: built.directory,
    memory: built.memory,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, databaseUrl, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("/v1/admin/users: org_admin sees the roster + grants; a non-admin is denied; audited", async () => {
  const s = start();
  try {
    const pg = createPgPool(s.databaseUrl);
    await pg.query(
      `INSERT INTO directory_members(org_id, principal_id, display_name, display_name_lc, type, slack_id)
       VALUES ('default-org', 'Uno@Example.com', 'Uno', 'uno', 'internal', 'U1'),
              ('default-org', 'Seven@Example.com', 'Seven', 'seven', 'internal', 'U7'),
              ('default-org', 'U-bot', 'Some App', 'some app', 'internal', NULL)`,
    );
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");
    const session = await s.built.sessions.getByThread("dm:U1:t1");
    await s.built.sessions.addParticipant(session!.id, "U-preloaded");
    await s.built.app.turn({
      ...dm,
      actor: { externalId: "U-cron" },
      conversation: { kind: "dm", threadRef: "dm:U-cron:t1" },
      origin: { kind: "automation" },
    });
    await s.built.app.turn({
      ...dm,
      actor: { externalId: "U-bot" },
      conversation: { kind: "dm", threadRef: "dm:U-bot:t1" },
      botActor: true,
    });
    await s.built.app.turn({
      ...dm,
      actor: { externalId: "smoke-test" },
      conversation: { kind: "dm", threadRef: "dm:smoke:t1" },
    });
    await s.built.app.turn({
      ...dm,
      actor: { externalId: "Talker@Example.com" },
      conversation: { kind: "dm", threadRef: "dm:talker:t1" },
    });

    const r = await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    const talker = d.users.find((u: { principalId: string }) => u.principalId === "talker@example.com");
    assert.equal(talker?.source, "turn", "someone who talked is on the roster");
    assert.equal(typeof talker?.firstSeenAt, "number");
    assert.equal(talker?.turnCount, 1);
    const listed = (id: string) => d.users.some((u: { principalId: string }) => u.principalId === id);
    assert.deepEqual(
      ["U1", "smoke-test"].filter(listed),
      ["U1", "smoke-test"],
      "any author who isn't a bot counts; a Slack id becomes one person with its email only through a link",
    );
    assert.deepEqual(
      ["U-preloaded", "U-cron", "U-bot"].filter(listed),
      [],
      "not someone only added, an automation's target, or a turn flagged as a bot",
    );
    assert.ok(
      Array.isArray(d.grants) && d.grants.some((g: { principalId: string }) => g.principalId === "admin-alice"),
      "authoritative grants present",
    );

    const migration = USER_MIGRATIONS.find((m) => m.id === "users/0002-copy-principal-links")!.statements[0]!;
    await pg.query("CREATE TABLE principal_links (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await pg.query(
      `INSERT INTO principal_links VALUES ('u-self', '{"principalId":"U-Self","canonicalId":"u-self","evidence":"qa","linkedBy":"admin-alice","createdAt":2}')`,
    );
    await assert.rejects(pg.query(migration), /cannot be copied.*u-self/, "a bad legacy row stops the migration");
    await pg.query("DROP TABLE principal_links");
    await pg.query("DELETE FROM users");
    await pg.query("CREATE TABLE IF NOT EXISTS principal_links (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await pg.query(
      `INSERT INTO principal_links VALUES ('U1', '{"principalId":"U1","canonicalId":"Pat@Example.com","evidence":"qa","linkedBy":"admin-alice","createdAt":1}')`,
    );
    await pg.query(
      `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, origin) VALUES ('hist-s', 'channel', 'org:default-org', 'hist:1', 1, 'conversation')`,
    );
    await pg.query(
      `INSERT INTO items(tenant_id, session_id, seq, kind, author, text, body, created_at)
       VALUES (qm_bound_tenant(), 'hist-s', 1, 'UserMessage', 'U7', 'hi', '{}', now() - interval '1 day'),
              (qm_bound_tenant(), 'hist-s', 2, 'UserMessage', 'Seven@Example.com', 'hi', '{}', now()),
              (qm_bound_tenant(), 'hist-s', 3, 'UserMessage', 'U9', 'hi', '{}', now())`,
    );
    await pg.query(
      `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, origin, spawn_meta)
       VALUES ('ext-s', 'channel', 'org:default-org', 'ext:1', 1, 'conversation', '{"surfaceOrigin":{"audience":"external"}}')`,
    );
    await pg.query(
      `INSERT INTO items(tenant_id, session_id, seq, kind, author, text, body, created_at)
       VALUES (qm_bound_tenant(), 'ext-s', 1, 'UserMessage', 'U-ext', 'hi', '{}', now())`,
    );
    await s.built.identity.putExternalMember({
      email: "Mate@Example.com",
      role: "member",
      expiresAt: null,
      kind: "teammate",
      invitedBy: "admin-alice",
      createdAt: 5,
      updatedAt: 5,
    });
    for (const m of USER_MIGRATIONS.filter((m) => /^users\/000[234]/.test(m.id)))
      for (const statement of m.statements) await pg.query(statement);
    assert.deepEqual(
      (await pg.q("SELECT alias_id, user_id, evidence FROM user_links ORDER BY alias_id")).map((r) => [
        r.alias_id,
        r.user_id,
        r.evidence,
      ]),
      [
        ["U1", "pat@example.com", "qa"],
        ["U7", "seven@example.com", "slack directory: slack_id→principal_id"],
      ],
      "existing links are copied, and a Slack-id author the directory maps to someone else is linked to them",
    );
    assert.equal((await pg.q("SELECT to_regclass('principal_links') AS t"))[0]!.t, null, "and the old map is dropped");
    const users = new Map((await pg.q("SELECT id, source FROM users")).map((r) => [r.id as string, r.source]));
    assert.equal(users.get("pat@example.com"), "turn", "a linked writer's history lands on their canonical user");
    assert.equal(users.has("U1"), false, "with no row for the alias");
    assert.equal(users.get("seven@example.com"), "turn", "the directory-mapped Slack-id author folds into their email");
    assert.equal(users.has("U7"), false);
    const [seven] = await pg.q(
      "SELECT first_seen_at < now() - interval '12 hours' AS early FROM users WHERE id = 'seven@example.com'",
    );
    assert.equal(seven!.early, true, "and the email's first-seen includes the Slack-id messages");
    assert.equal(users.get("U9"), "turn", "an unmapped Slack id is its own person");
    assert.equal(users.get("U-bot"), "turn", "history keeps no bot flag, so an app that wrote gets a row");
    assert.equal(users.get("smoke-test"), "turn");
    assert.equal(users.get("admin-alice"), "admin", "an existing grant holder gets a row");
    assert.equal(users.get("mate@example.com"), "invite", "as does an existing teammate");
    const backfilled = [...users.keys()];
    assert.deepEqual(
      ["U1", "U-preloaded", "U-cron", "U-ext"].filter((id) => backfilled.includes(id)),
      [],
      "no linked alias, automation target, external member or added-only participant",
    );

    const denied = await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "users.read"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users: each person carries the pseudonym the model gateway receives for them", async () => {
  const gateway = { url: "https://gateway.test", apiKey: "k", apiKeyHeader: "api-key", models: {} };
  const s = start({ modelGatewayTransport: { ...gateway, actorKey: "gateway-actor-key" } });
  const unkeyed = start({ modelGatewayTransport: gateway });
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "una@example.com" },
      conversation: { kind: "dm", threadRef: "dm:una:pseudonym" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");
    const roster = async (base: string) =>
      (
        (await (
          await fetch(`${base}/v1/admin/users`, { headers: { "x-admin-actor": "admin-alice@default-org" } })
        ).json()) as {
          users: Array<{ principalId: string; gatewayActor?: string }>;
        }
      ).users.find((u) => u.principalId === "una@example.com");
    assert.equal((await roster(s.base))?.gatewayActor, gatewayActorId("una@example.com", "gateway-actor-key"));
    assert.equal((await unkeyed.built.app.turn(dm)).status, "ok");
    assert.equal((await roster(unkeyed.base))?.gatewayActor, undefined);
  } finally {
    await s.close();
    await unkeyed.close();
  }
});

test("/v1/admin/users/:principalId: per-user detail counts personal conversations without loading org history or artifacts; non-admin denied; audited", async (t) => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    await s.built.app.turn({ ...dm, actor: { externalId: "U2" }, conversation: { kind: "dm", threadRef: "dm:U2:t1" } });
    await s.built.app.turn({ ...dm, conversation: { kind: "channel", channelRef: "C1", threadRef: "channel:C1:t1" } });
    const fail = () => {
      throw new Error("User detail must not load org history or artifact lists");
    };
    t.mock.method(s.built.sessions, "listParticipants", fail);
    t.mock.method(s.built.sessions, "attributedTurns", fail);
    t.mock.method(s.built.sessions, "scopeSessionSummaries", fail);
    t.mock.method(s.built.files, "listOwnedByScopes", fail);
    t.mock.method(s.built.app, "listCrons", fail);
    t.mock.method(s.built.app, "listDeployments", fail);

    const r = await fetch(`${s.base}/v1/admin/users/U1`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.equal(d.principalId, "U1");
    assert.equal(d.scopeId, "personal:U1");
    assert.equal(d.stats.sessions, 1);
    for (const key of ["conversations", "files", "crons", "deployments"]) assert.equal(key in d, false);

    const denied = await fetch(`${s.base}/v1/admin/users/U1`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "user.read"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users/:principalId/onboarding: org_admin sets/resets state, reflected in detail; bad input + non-admin rejected; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hi",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");
    const adminHdr = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
    const detail = async () =>
      (await (await fetch(`${s.base}/v1/admin/users/U1`, { headers: adminHdr })).json()) as any;
    const setOb = (status: string, actor = "admin-alice@default-org") =>
      fetch(`${s.base}/v1/admin/users/U1/onboarding`, {
        method: "PUT",
        headers: { "x-admin-actor": actor, "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });

    assert.equal((await detail()).onboarding, "not_started");

    assert.equal((await setOb("completed")).status, 200);
    assert.equal((await detail()).onboarding, "completed");

    assert.equal((await setOb("not_started")).status, 200);
    assert.equal((await detail()).onboarding, "not_started");

    assert.equal((await setOb("nope")).status, 400);
    assert.equal((await setOb("completed", "user-uma@default-org")).status, 403);

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "user.onboarding.set"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users/:principalId/reset: deletes the user's personal sessions + clears onboarding; non-admin denied; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hi",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");
    const adminHdr = { "x-admin-actor": "admin-alice@default-org" };
    const detail = async () =>
      (await (await fetch(`${s.base}/v1/admin/users/U1`, { headers: adminHdr })).json()) as any;

    await fetch(`${s.base}/v1/admin/users/U1/onboarding`, {
      method: "PUT",
      headers: { ...adminHdr, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    let d = await detail();
    assert.equal(d.stats.sessions, 1, "one personal DM session before reset");
    assert.equal(d.onboarding, "completed");

    const denied = await fetch(`${s.base}/v1/admin/users/U1/reset`, {
      method: "POST",
      headers: { "x-admin-actor": "user-uma@default-org" },
    });
    assert.equal(denied.status, 403);

    const reset = await fetch(`${s.base}/v1/admin/users/U1/reset`, { method: "POST", headers: adminHdr });
    assert.equal(reset.status, 200);
    assert.equal(((await reset.json()) as any).deletedSessions, 1);

    d = await detail();
    assert.equal(d.stats.sessions, 0, "session wiped → user looks brand-new");
    assert.equal("conversations" in d, false);
    assert.equal(d.onboarding, "not_started", "onboarding marker cleared");

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "user.reset"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users/:principalId: a grant-holder with no sessions still resolves with admin status", async () => {
  const s = start();
  try {
    const d: any = await (
      await fetch(`${s.base}/v1/admin/users/${encodeURIComponent("admin-alice")}`, {
        headers: { "x-admin-actor": "admin-alice@default-org" },
      })
    ).json();
    assert.equal(d.principalId, "admin-alice");
    assert.equal(d.admin.isAdmin, true);
    assert.equal(d.stats.sessions, 0);
    assert.equal("conversations" in d, false);
  } finally {
    await s.close();
  }
});

test("/v1/admin/directory: org_admin resolves a name or id to candidates; empty query → []; non-admin denied", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-dir-")),
      emailAuthPrincipals: ["new@example.com"],
    }),
  );
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    memory: built.memory,
    auditLog: built.auditLog,
    directory: built.directory,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await built.directory.replace([
      { principalId: "dana@example.com", displayName: "Dana Example", type: "internal" },
      { principalId: "jane@example.com", displayName: "Jane Doe", type: "internal" },
    ]);

    const r = await fetch(`${base}/v1/admin/directory?q=${encodeURIComponent("dana")}`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.ok(
      d.members.some((m: any) => m.principalId === "dana@example.com" && m.displayName === "Dana Example"),
      "name prefix resolves the member",
    );
    assert.ok(!d.members.some((m: any) => m.principalId === "jane@example.com"), "non-matching member excluded");

    const onboarded = await fetch(`${base}/v1/admin/directory?q=${encodeURIComponent("new@example.com")}`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(onboarded.status, 200);
    assert.deepEqual(((await onboarded.json()) as any).members, [
      { principalId: "new@example.com", displayName: "new@example.com" },
    ]);

    const empty = await fetch(`${base}/v1/admin/directory`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.deepEqual(((await empty.json()) as any).members, [], "no query → no candidates");

    const denied = await fetch(`${base}/v1/admin/directory?q=dana`, {
      headers: { "x-admin-actor": "user-uma@default-org" },
    });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
});

test("/v1/admin/users: a freshly promoted user shows as admin in the roster", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U9" },
      conversation: { kind: "dm", threadRef: "dm:U9:t1" },
      text: "hi",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");
    await fetch(`${s.base}/v1/admin/grants`, {
      method: "POST",
      headers: { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U9", role: "org_admin", scopeId: "org:default-org" }),
    });
    const d: any = await (
      await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "admin-alice@default-org" } })
    ).json();
    const u9 = d.users.find((u: { principalId: string }) => u.principalId === "U9");
    assert.ok(u9 && u9.admin.role === "org_admin");
  } finally {
    await s.close();
  }
});

test("user detail resolves mixed-case email links to the canonical personal scope", async (t) => {
  const s = start();
  try {
    t.mock.method(s.built.sessions, "scopeConversationCount", async (scope: string) => {
      assert.equal(scope, "personal:alice@example.com");
      return 3;
    });
    const response = await fetch(`${s.base}/v1/admin/users/Alice%40example.com`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as any;
    assert.equal(data.principalId, "alice@example.com");
    assert.equal(data.scopeId, "personal:alice@example.com");
    assert.equal(data.stats.sessions, 3);
  } finally {
    await s.close();
  }
});

for (const canonicalPrincipal of ["alice@example.com", "Alice@example.com"]) {
  test(`mixed-case user mutations target canonical scope ${canonicalPrincipal}`, async () => {
    const s = start();
    try {
      if (canonicalPrincipal === "Alice@example.com")
        await s.built.directory.replace([{ principalId: canonicalPrincipal, displayName: "Alice", type: "internal" }]);
      const scope = "personal:" + canonicalPrincipal;
      const session = await s.built.sessions.getOrCreateByThread("dm:case-test", "dm", scope);
      await s.built.sessions.addParticipant(session.id, canonicalPrincipal);
      const other = await s.built.sessions.getOrCreateByThread("channel:case-test", "channel", "channel:C1");
      await s.built.sessions.addParticipant(other.id, canonicalPrincipal);
      const base = `${s.base}/v1/admin/users/ALICE%40example.com`;
      const headers = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
      const detail = async () => (await (await fetch(base, { headers })).json()) as any;
      const update = await fetch(base + "/onboarding", {
        method: "PUT",
        headers,
        body: JSON.stringify({ status: "completed" }),
      });
      assert.equal(update.status, 200);
      assert.equal(((await update.json()) as any).scopeId, scope);
      assert.equal((await detail()).onboarding, "completed");
      const reset = await fetch(base + "/reset", { method: "POST", headers });
      assert.equal(reset.status, 200);
      assert.equal(((await reset.json()) as any).deletedSessions, 1);
      assert.equal((await detail()).onboarding, "not_started");
      assert.equal((await detail()).stats.sessions, 0);
      assert.equal(await s.built.sessions.get(session.id), null);
      assert.ok(await s.built.sessions.get(other.id));
      assert.equal(await s.built.memory.read("personal:ALICE@example.com"), "");
    } finally {
      await s.close();
    }
  });
}
