import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { INVITE_EMAIL_NOT_CONFIGURED, renderInviteEmail, type InviteMailer } from "../src/admin/invite-email.ts";
import { adminStatusFromGrants } from "../src/admin/admin-service.ts";
import { coreEmailAllowed } from "../plugins/chassis/src/external-members.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const ALICE = "admin-alice@default-org";
const NOBODY = "user-uma@default-org";
const SECRET = "external-users-test-secret".repeat(2);
const PORTAL = "https://portal.example.com";
const ORG = scopeId("org", "default-org");
const DAY_MS = 24 * 60 * 60 * 1000;

type Sent = { to: string; subject: string; text: string; html: string };

function stubMailer(fail?: string): { sent: Sent[]; mailer: InviteMailer } {
  const sent: Sent[] = [];
  return {
    sent,
    mailer: {
      async send(message) {
        if (fail) throw new Error(fail);
        sent.push(message);
        return "msg-1";
      },
    },
  };
}

function start(
  opts: { mailer?: InviteMailer; signed?: boolean; emailAuthDomain?: string; emailAuthPrincipals?: string[] } = {},
) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-external-users-")),
      ...(opts.signed ? { signingSecret: SECRET } : {}),
    }),
  );
  const deps = {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    identity: built.identity,
    directory: built.directory,
    config: built.config,
    portalUrl: PORTAL,
    brandingDefault: { selfLabel: "Acme Bot" },
    ...(opts.mailer ? { inviteMailer: opts.mailer } : {}),
    ...(opts.emailAuthDomain ? { emailAuthDomain: opts.emailAuthDomain } : {}),
    ...(opts.emailAuthPrincipals ? { emailAuthPrincipals: opts.emailAuthPrincipals } : {}),
  };
  const server = opts.signed
    ? createServer(built.app, { ...deps, signingSecret: SECRET })
    : createInsecureTestServer(built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const invite = (base: string, body: unknown, headers: Record<string, string> = { "x-admin-actor": ALICE }) =>
  fetch(`${base}/v1/admin/external-users`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const revoke = (base: string, email: string, headers: Record<string, string> = { "x-admin-actor": ALICE }) =>
  fetch(`${base}/v1/admin/external-users/${encodeURIComponent(email)}`, { method: "DELETE", headers });
const roster = async (base: string, headers: Record<string, string> = { "x-admin-actor": ALICE }): Promise<any> =>
  (await fetch(`${base}/v1/admin/users`, { headers })).json();

const capFor = (actorId: string) =>
  mintCapabilityToken(
    {
      actorId,
      scopeId: scopeId("personal", actorId),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );

test("inviting an external user stores the record, lists it as active, audits, and reports the missing mailer", async () => {
  const s = start();
  try {
    const expiresAt = new Date(Date.now() + 30 * DAY_MS).toISOString();
    const r = await invite(s.base, { email: "  Pat@Partner.example  ", expiresAt });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.created, true);
    assert.equal(d.member.email, "pat@partner.example");
    assert.equal(d.member.role, "member");
    assert.equal(d.member.invitedBy, "admin-alice");
    assert.equal(d.member.expiresAt, Date.parse(expiresAt));
    assert.equal(d.emailSent, false);
    assert.equal(d.emailProblem, INVITE_EMAIL_NOT_CONFIGURED);
    assert.equal(d.signInUrl, `${PORTAL}/auth/login`);

    const list = await roster(s.base);
    assert.deepEqual(list.inviteEmail, {
      configured: false,
      problem: INVITE_EMAIL_NOT_CONFIGURED,
      signInUrl: `${PORTAL}/auth/login`,
    });
    assert.equal(list.externalUsers.length, 1);
    assert.equal(list.externalUsers[0].email, "pat@partner.example");
    assert.equal(list.externalUsers[0].status, "active");
    assert.ok(!list.users.some((u: any) => u.principalId === "pat@partner.example"), "not folded into users");

    const again = await invite(s.base, { email: "pat@partner.example", expiresAt: Date.now() + 60 * DAY_MS });
    const updated: any = await again.json();
    assert.equal(updated.created, false);
    assert.equal(updated.member.createdAt, d.member.createdAt);
    assert.equal(updated.emailSent, false);
    assert.equal(updated.emailProblem, undefined, "an update does not retry the invitation email");

    const events = await s.built.auditLog.events();
    assert.ok(events.some((e) => e.action === "external_user.invite" && e.resource === "pat@partner.example"));
    assert.ok(events.some((e) => e.action === "external_user.update" && e.resource === "pat@partner.example"));

    assert.equal((await invite(s.base, { email: "x@y.example", expiresAt }, { "x-admin-actor": NOBODY })).status, 403);
  } finally {
    await s.close();
  }
});

test("role org_admin grants admin; member revokes it; DELETE drops the grant and expires the record", async () => {
  const s = start();
  try {
    const expiresAt = Date.now() + 7 * DAY_MS;
    const isAdmin = async (email: string) => adminStatusFromGrants(await s.built.admin.listGrants(), email).isAdmin;

    assert.equal((await invite(s.base, { email: "boss@partner.example", role: "org_admin", expiresAt })).status, 200);
    assert.equal(await isAdmin("boss@partner.example"), true);

    assert.equal((await invite(s.base, { email: "boss@partner.example", role: "member", expiresAt })).status, 200);
    assert.equal(await isAdmin("boss@partner.example"), false);

    assert.equal((await invite(s.base, { email: "boss@partner.example", role: "org_admin", expiresAt })).status, 200);
    assert.equal(await isAdmin("boss@partner.example"), true);
    assert.equal(s.built.identity.classify("boss@partner.example").type, "internal");

    const gone = await revoke(s.base, "Boss@Partner.example");
    assert.equal(gone.status, 200);
    assert.equal(await isAdmin("boss@partner.example"), false);
    assert.equal(
      s.built.identity.classify("boss@partner.example").type,
      "guest",
      "a revoked external loses access now",
    );
    const tomb = s.built.identity.externalMember("boss@partner.example");
    assert.equal(tomb?.role, "member");
    assert.ok(tomb!.expiresAt <= Date.now());
    assert.deepEqual(
      (await roster(s.base)).externalUsers.map((m: any) => [m.email, m.status]),
      [["boss@partner.example", "expired"]],
    );
    const events = await s.built.auditLog.events();
    assert.ok(events.some((e) => e.action === "external_user.revoke"));
    assert.deepEqual(
      events.filter((e) => e.action === "grant.create" || e.action === "grant.revoke").map((e) => e.action),
      ["grant.create", "grant.revoke", "grant.create", "grant.revoke"],
    );

    const again: any = await (await revoke(s.base, "boss@partner.example")).json();
    assert.deepEqual(again, { ok: true, removed: false }, "revoking again is a no-op until a day has passed");
    assert.equal((await revoke(s.base, "nobody@partner.example")).status, 404);

    const back = await invite(s.base, { email: "boss@partner.example", expiresAt });
    assert.equal(((await back.json()) as any).created, false);
    assert.equal(s.built.identity.classify("boss@partner.example").type, "internal", "a new expiry readmits them");

    const now = Date.now();
    await s.built.identity.putExternalMember({
      email: "old@partner.example",
      role: "member",
      expiresAt: now - 2 * DAY_MS,
      invitedBy: "admin-alice",
      createdAt: now - 30 * DAY_MS,
      updatedAt: now - 2 * DAY_MS,
    });
    const forgotten: any = await (await revoke(s.base, "old@partner.example")).json();
    assert.deepEqual(forgotten, { ok: true, removed: true });
    assert.equal(s.built.identity.externalMember("old@partner.example"), undefined);
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "external_user.forget"));
  } finally {
    await s.close();
  }
});

test("an address that already belongs to an org member cannot be invited", async () => {
  const s = start({ emailAuthDomain: "corp.example", emailAuthPrincipals: ["ops@allowed.example"] });
  try {
    const expiresAt = Date.now() + DAY_MS;
    const alice = s.built.admin.resolveActor(ALICE)!;
    await s.built.admin.createGrant(alice, { principalId: "ceo@other.example", role: "org_admin", scopeId: ORG });
    await s.built.directory.replace([{ principalId: "dana@slack.example", displayName: "Dana", type: "internal" }]);
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "seen@elsewhere.example" },
      conversation: { kind: "dm", threadRef: "dm:seen:t1" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    for (const email of [
      "ceo@other.example",
      "Dana@Slack.example",
      "anyone@corp.example",
      "Ops@Allowed.example",
      "seen@elsewhere.example",
    ]) {
      const r = await invite(s.base, { email, expiresAt });
      assert.equal(r.status, 409, email);
      assert.match(((await r.json()) as any).message, /already belongs to a member/);
      assert.equal(s.built.identity.externalMember(email), undefined, email);
    }
    assert.equal(adminStatusFromGrants(await s.built.admin.listGrants(), "ceo@other.example").isAdmin, true);
    assert.deepEqual((await roster(s.base)).externalUsers, []);

    assert.equal((await invite(s.base, { email: "pat@partner.example", expiresAt })).status, 200);
    await s.built.admin.createGrant(alice, { principalId: "pat@partner.example", role: "org_admin", scopeId: ORG });
    const extend = await invite(s.base, { email: "pat@partner.example", expiresAt: expiresAt + DAY_MS });
    assert.equal(extend.status, 409, "a member record cannot silently carry an independently granted admin role");
    assert.match(((await extend.json()) as any).message, /holds an org admin grant/);
    const del = await revoke(s.base, "pat@partner.example");
    assert.equal(del.status, 409);
    assert.equal(adminStatusFromGrants(await s.built.admin.listGrants(), "pat@partner.example").isAdmin, true);
    assert.equal(s.built.identity.classify("pat@partner.example").type, "internal");

    const adopt: any = await (
      await invite(s.base, { email: "pat@partner.example", role: "org_admin", expiresAt: expiresAt + DAY_MS })
    ).json();
    assert.equal(adopt.member.role, "org_admin", "re-inviting with role org_admin adopts the grant");
    const grantAudits = (await s.built.auditLog.events()).filter((e) => e.resource === "pat@partner.example/org_admin");
    assert.deepEqual(grantAudits, [], "adopting an existing grant creates nothing");
    assert.equal((await revoke(s.base, "pat@partner.example")).status, 200);
    assert.equal(adminStatusFromGrants(await s.built.admin.listGrants(), "pat@partner.example").isAdmin, false);
  } finally {
    await s.close();
  }
});

test("an expired external org admin no longer passes the admin authorizer", async () => {
  const s = start();
  try {
    assert.equal(
      (await invite(s.base, { email: "boss@partner.example", role: "org_admin", expiresAt: Date.now() + DAY_MS }))
        .status,
      200,
    );
    const boss = { "x-admin-actor": "boss@partner.example@default-org" };
    assert.equal((await fetch(`${s.base}/v1/admin/users`, { headers: boss })).status, 200);
    const record = s.built.identity.externalMember("boss@partner.example")!;
    await s.built.identity.putExternalMember({ ...record, expiresAt: Date.now() - 1 });
    const denied = await fetch(`${s.base}/v1/admin/users`, { headers: boss });
    assert.equal(denied.status, 403);
    assert.match(((await denied.json()) as any).message, /no longer active/);
    const who: any = await (await fetch(`${s.base}/v1/admin/whoami`, { headers: boss })).json();
    assert.equal(who.isAdmin, false);
  } finally {
    await s.close();
  }
});

test("revoking the last org admin is refused and leaves the external record untouched", async () => {
  const s = start();
  try {
    const expiresAt = Date.now() + DAY_MS;
    assert.equal((await invite(s.base, { email: "boss@partner.example", role: "org_admin", expiresAt })).status, 200);
    const alice = s.built.admin.resolveActor(ALICE)!;
    await s.built.admin.revokeGrant(alice, "admin-bob", ORG, "org_admin");
    await s.built.admin.revokeGrant(alice, "admin-alice", ORG, "org_admin");

    const boss = { "x-admin-actor": "boss@partner.example@default-org" };
    const r = await revoke(s.base, "boss@partner.example", boss);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).message, /last org admin/);
    const kept = s.built.identity.externalMember("boss@partner.example");
    assert.equal(kept?.role, "org_admin");
    assert.equal(kept?.expiresAt, expiresAt);
    assert.ok(!(await s.built.auditLog.events()).some((e) => e.action === "external_user.revoke"));

    const demote = await invite(s.base, { email: "boss@partner.example", role: "member", expiresAt }, boss);
    assert.equal(demote.status, 400);
    assert.equal(s.built.identity.externalMember("boss@partner.example")?.role, "org_admin");
  } finally {
    await s.close();
  }
});

test("invite validation: past expiry, missing expiry, bad email, and bad role are 400", async () => {
  const s = start();
  try {
    const cases: unknown[] = [
      { email: "a@b.example", expiresAt: Date.now() - 1000 },
      { email: "a@b.example" },
      { email: "a@b.example", expiresAt: "not a date" },
      { email: "not-an-email", expiresAt: Date.now() + DAY_MS },
      { email: "a@b.example", role: "owner", expiresAt: Date.now() + DAY_MS },
    ];
    for (const body of cases) {
      const r = await invite(s.base, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(((await r.json()) as any).error, "bad_request");
    }
    assert.deepEqual((await roster(s.base)).externalUsers, []);

    const dated: any = await (await invite(s.base, { email: "a@b.example", expiresAt: "2031-03-04" })).json();
    assert.equal(dated.member.expiresAt, Date.UTC(2031, 2, 4, 23, 59, 59, 999), "a bare date ends that day, UTC");
  } finally {
    await s.close();
  }
});

test("with a mailer the invitation goes out carrying the sign-in URL and brand; a send failure still saves the record", async () => {
  const ok = stubMailer();
  const s = start({ mailer: ok.mailer });
  try {
    const expiresAt = Date.now() + 14 * DAY_MS;
    const r: any = await (await invite(s.base, { email: "pat@partner.example", expiresAt })).json();
    assert.equal(r.emailSent, true);
    assert.equal(r.emailProblem, undefined);
    assert.equal(ok.sent.length, 1);
    assert.equal(ok.sent[0]!.to, "pat@partner.example");
    assert.match(ok.sent[0]!.subject, /invited to Acme Bot/);
    assert.ok(ok.sent[0]!.text.includes(`${PORTAL}/auth/login`));
    assert.match(ok.sent[0]!.text, /admin-alice/);
    assert.match(ok.sent[0]!.html, /Acme Bot/);
    assert.equal((await roster(s.base)).inviteEmail.configured, true);

    const resent: any = await (
      await invite(s.base, { email: "pat@partner.example", expiresAt, resendInvite: true })
    ).json();
    assert.equal(resent.emailSent, true);
    assert.equal(ok.sent.length, 2);

    assert.equal((await revoke(s.base, "pat@partner.example")).status, 200);
    const readmit: any = await (await invite(s.base, { email: "pat@partner.example", expiresAt })).json();
    assert.equal(readmit.created, false);
    assert.equal(readmit.emailSent, true, "readmitting a revoked address sends the invitation again");
    assert.equal(ok.sent.length, 3);
    const extend: any = await (
      await invite(s.base, { email: "pat@partner.example", expiresAt: expiresAt + DAY_MS })
    ).json();
    assert.equal(extend.emailSent, false, "extending an active member sends nothing");
    assert.equal(ok.sent.length, 3);
  } finally {
    await s.close();
  }

  const broken = stubMailer("Resend rejected the message: HTTP 403 domain not verified");
  const f = start({ mailer: broken.mailer });
  try {
    const r: any = await (
      await invite(f.base, { email: "sam@partner.example", expiresAt: Date.now() + DAY_MS })
    ).json();
    assert.equal(r.ok, true);
    assert.equal(r.emailSent, false);
    assert.match(r.emailProblem, /HTTP 403 domain not verified/);
    assert.equal(r.signInUrl, `${PORTAL}/auth/login`);
    assert.equal(f.built.identity.externalMember("sam@partner.example")?.role, "member");
  } finally {
    await f.close();
  }
});

test("renderInviteEmail escapes HTML and names the sign-in URL and expiry", () => {
  const mail = renderInviteEmail({
    to: "pat@partner.example",
    brandName: "<Acme>",
    invitedBy: "admin-alice",
    signInUrl: "https://portal.example.com/auth/login",
    expiresAt: Date.UTC(2030, 0, 2),
  });
  assert.equal(mail.subject, "You've been invited to <Acme>");
  assert.match(mail.html, /&lt;Acme&gt;/);
  assert.doesNotMatch(mail.html, /<Acme>/);
  assert.match(mail.text, /https:\/\/portal\.example\.com\/auth\/login/);
  assert.match(mail.text, /02 Jan 2030/);
});

test("an agent token may invite a member but never grant, demote, or revoke an org_admin external", async () => {
  const s = start({ signed: true });
  try {
    const cap = { "x-agent-capability": await capFor("admin-alice") };
    const expiresAt = Date.now() + DAY_MS;

    const member = await invite(s.base, { email: "pat@partner.example", expiresAt }, cap);
    assert.equal(member.status, 200);
    assert.equal(((await member.json()) as any).member.invitedBy, "admin-alice");

    const promote = await invite(s.base, { email: "boss@partner.example", role: "org_admin", expiresAt }, cap);
    assert.equal(promote.status, 403);
    assert.match(((await promote.json()) as any).message, /portal-only/);
    assert.equal(s.built.identity.externalMember("boss@partner.example"), undefined);

    const now = Date.now();
    await s.built.identity.putExternalMember({
      email: "boss@partner.example",
      role: "org_admin",
      expiresAt,
      invitedBy: "admin-bob",
      createdAt: now,
      updatedAt: now,
    });
    const demote = await invite(s.base, { email: "boss@partner.example", role: "member", expiresAt }, cap);
    assert.equal(demote.status, 403);
    const del = await revoke(s.base, "boss@partner.example", cap);
    assert.equal(del.status, 403);
    assert.match(((await del.json()) as any).message, /portal-only/);
    assert.equal(s.built.identity.externalMember("boss@partner.example")?.role, "org_admin");

    assert.equal((await revoke(s.base, "pat@partner.example", cap)).status, 200);
    assert.equal(s.built.identity.classify("pat@partner.example").type, "guest");

    const alice = s.built.admin.resolveActor(ALICE)!;
    await s.built.admin.createGrant(alice, { principalId: "ceo@corp.example", role: "org_admin", scopeId: ORG });
    const demoteViaInvite = await invite(s.base, { email: "ceo@corp.example", role: "member", expiresAt }, cap);
    assert.equal(demoteViaInvite.status, 409);
    assert.equal(adminStatusFromGrants(await s.built.admin.listGrants(), "ceo@corp.example").isAdmin, true);
    assert.equal(s.built.identity.externalMember("ceo@corp.example"), undefined);

    await s.built.identity.putExternalMember({
      email: "promoted@partner.example",
      role: "member",
      expiresAt,
      invitedBy: "admin-bob",
      createdAt: now,
      updatedAt: now,
    });
    await s.built.admin.createGrant(alice, {
      principalId: "promoted@partner.example",
      role: "org_admin",
      scopeId: ORG,
    });
    for (const attempt of [
      revoke(s.base, "promoted@partner.example", cap),
      invite(s.base, { email: "promoted@partner.example", role: "member", expiresAt: expiresAt + DAY_MS }, cap),
    ]) {
      const r = await attempt;
      assert.equal(r.status, 403);
      assert.match(((await r.json()) as any).message, /portal-only/);
    }
    assert.equal(s.built.identity.classify("promoted@partner.example").type, "internal");
    assert.equal(adminStatusFromGrants(await s.built.admin.listGrants(), "promoted@partner.example").isAdmin, true);

    assert.equal((await invite(s.base, { email: "x@y.example", expiresAt }, { "x-admin-actor": ALICE })).status, 401);
  } finally {
    await s.close();
  }
});

test("expiry classifies an external as guest, and the signed broker check answers accordingly", async () => {
  const s = start({ signed: true });
  try {
    const now = Date.now();
    const record = (email: string, expiresAt: number) => ({
      email,
      role: "member" as const,
      expiresAt,
      invitedBy: "admin-alice",
      createdAt: now,
      updatedAt: now,
    });
    await s.built.identity.putExternalMember(record("live@partner.example", now + DAY_MS));
    await s.built.identity.putExternalMember(record("gone@partner.example", now - 1));
    assert.equal(s.built.identity.classify("live@partner.example").type, "internal");
    assert.equal(s.built.identity.classify("Gone@Partner.example").type, "guest");

    assert.equal(await coreEmailAllowed(s.base, SECRET, "Live@Partner.example", "test"), true);
    assert.equal(await coreEmailAllowed(s.base, SECRET, "gone@partner.example", "test"), false);
    assert.equal(await coreEmailAllowed(s.base, SECRET, "stranger@partner.example", "test"), false);
    assert.equal(await coreEmailAllowed(s.base, "wrong-secret".repeat(4), "live@partner.example", "test"), false);
    assert.equal(await coreEmailAllowed("http://127.0.0.1:1", SECRET, "live@partner.example", "test"), false);
    const unsigned = await fetch(`${s.base}/v1/auth/broker/email-allowed?email=live%40partner.example`);
    assert.equal(unsigned.status, 401);

    await s.built.identity.deactivate("live@partner.example");
    assert.equal(await coreEmailAllowed(s.base, SECRET, "live@partner.example", "test"), false);
    await s.built.identity.reactivate("live@partner.example");

    const list = await roster(s.base, { "x-agent-capability": await capFor("admin-alice") });
    assert.deepEqual(
      list.externalUsers.map((m: any) => [m.email, m.status]),
      [
        ["live@partner.example", "active"],
        ["gone@partner.example", "expired"],
      ],
    );
  } finally {
    await s.close();
  }
});

test("the directory resolves an active external member and not an expired one", async () => {
  const s = start();
  try {
    const now = Date.now();
    const record = (email: string, expiresAt: number) => ({
      email,
      role: "member" as const,
      expiresAt,
      invitedBy: "admin-alice",
      createdAt: now,
      updatedAt: now,
    });
    await s.built.identity.putExternalMember(record("live@partner.example", now + DAY_MS));
    await s.built.identity.putExternalMember(record("gone@partner.example", now - 1));

    assert.deepEqual(await s.built.app.directoryMember("Live@Partner.example"), {
      principalId: "live@partner.example",
      displayName: "live@partner.example",
      type: "internal",
    });
    assert.equal(await s.built.app.directoryMember("gone@partner.example"), null);
    assert.equal((await s.built.app.resolveRecipient("live@partner.example")).kind, "one");
    assert.equal((await s.built.app.resolveRecipient("gone@partner.example")).kind, "none");
    assert.ok((await s.built.app.directoryMembers()).some((m) => m.principalId === "live@partner.example"));
    assert.ok(!(await s.built.app.directoryMembers()).some((m) => m.principalId === "gone@partner.example"));

    const hit = await fetch(`${s.base}/v1/admin/directory?q=${encodeURIComponent("live@partner.example")}`, {
      headers: { "x-admin-actor": ALICE },
    });
    assert.deepEqual(((await hit.json()) as any).members, [
      { principalId: "live@partner.example", displayName: "live@partner.example" },
    ]);
  } finally {
    await s.close();
  }
});

test("directory sync never deactivates an external member; manual deactivation still wins", async () => {
  const s = start();
  try {
    const now = Date.now();
    await s.built.identity.putExternalMember({
      email: "live@partner.example",
      role: "member",
      expiresAt: now + DAY_MS,
      invitedBy: "admin-alice",
      createdAt: now,
      updatedAt: now,
    });
    const outcome = await s.built.identity.recordDirectorySync(["live@partner.example"], []);
    assert.deepEqual(outcome.deactivated, []);
    assert.equal(s.built.identity.classify("live@partner.example").type, "internal");
    await s.built.identity.deactivate("live@partner.example");
    assert.equal(s.built.identity.classify("live@partner.example").type, "guest");
  } finally {
    await s.close();
  }
});
