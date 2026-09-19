import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { computeUsers } from "../src/admin/users.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("computeUsers dedupes participants, credits in-window turns, and joins admin status", () => {
  const participants = [
    { sessionId: "s1", principalId: "U1", validFrom: 100, validTo: null, validFromSeq: null, validToSeq: null },
    { sessionId: "s2", principalId: "U1", validFrom: 200, validTo: null, validFromSeq: null, validToSeq: null },
    { sessionId: "s1", principalId: "U2", validFrom: 100, validTo: null, validFromSeq: null, validToSeq: null },
  ];
  const turns = [
    { principalId: "U1", sessionId: "s1", day: 0, turns: 2, firstAt: 150, lastAt: 160 },
    { principalId: "U2", sessionId: "s1", day: 0, turns: 2, firstAt: 150, lastAt: 160 },
    { principalId: "U1", sessionId: "s2", day: 0, turns: 1, firstAt: 250, lastAt: 250 },
  ];
  const grants = [{ principalId: "U2", scopeId: "org:default-org", role: "org_admin" as const }];
  const rows = computeUsers({ participants, turns, grants });
  const byId: Record<string, any> = Object.fromEntries(rows.map((r) => [r.principalId, r]));

  assert.equal(byId.U1.sessionCount, 2);
  assert.equal(byId.U1.turnCount, 3);
  assert.equal(byId.U1.lastSeenAt, 250);
  assert.deepEqual(byId.U1.admin, { isAdmin: false });
  assert.equal(byId.U2.admin.role, "org_admin");
  assert.equal(rows[0]!.principalId, "U2");
});

test("computeUsers sums a window's turn rollup and takes its latest timestamp", () => {
  const rows = computeUsers({
    participants: [
      { sessionId: "s1", principalId: "U1", validFrom: 100, validTo: 200, validFromSeq: null, validToSeq: null },
    ],
    turns: [{ principalId: "U1", sessionId: "s1", day: 0, turns: 2, firstAt: 100, lastAt: 199 }],
    grants: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.turnCount, 2, "the window's two in-window turns");
  assert.equal(rows[0]!.lastSeenAt, 199);
});

test("computeUsers includes a grant-holder who has never participated", () => {
  const rows = computeUsers({
    participants: [],
    turns: [],
    grants: [{ principalId: "ghost-admin", scopeId: "org:default-org", role: "org_admin" as const }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.principalId, "ghost-admin");
  assert.equal(rows[0]!.sessionCount, 0);
  assert.equal(rows[0]!.lastSeenAt, null);
  assert.equal(rows[0]!.admin.isAdmin, true);
});

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-users-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    files: built.files,
    directory: built.directory,
    memory: built.memory,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("/v1/admin/users: org_admin sees the roster + grants; a non-admin is denied; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const r = await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.ok(
      d.users.some((u: { principalId: string }) => u.principalId === "U1"),
      "the DM participant appears",
    );
    assert.ok(
      Array.isArray(d.grants) && d.grants.some((g: { principalId: string }) => g.principalId === "admin-alice"),
      "authoritative grants present",
    );

    const denied = await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "users.read"));
  } finally {
    await s.close();
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
    const stats = await s.built.sessions.scopeSessionStats("personal:alice@example.com", false, "conversation");
    t.mock.method(s.built.sessions, "scopeSessionStats", async (scope: string) => {
      assert.equal(scope, "personal:alice@example.com");
      return { ...stats, total: 3 };
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
