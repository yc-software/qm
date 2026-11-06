import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };

function deployment(id: string, ownerScopeId: string, createdBy: string): Deployment {
  return {
    id,
    ownerScopeId: ownerScopeId as Deployment["ownerScopeId"],
    createdBy,
    name: id,
    currentVersion: 1,
    status: "running",
    endpoint: null,
    versions: [],
  };
}

async function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-offboard-")) }));
  const deployments = [
    deployment("app-personal", "personal:U1", "U1"),
    deployment("app-shared", "channel:C1", "U1"),
    deployment("app-other", "personal:U9", "U9"),
    deployment("app-broken", "personal:U1", "U1"),
  ];
  const archivedApps: string[] = [];
  const app = {
    ...built.app,
    listDeployments: async () => deployments,
    archiveDeployment: async (id: string) => {
      if (id === "app-broken") throw new Error("runtime destroy failed");
      archivedApps.push(id);
      deployments.find((d) => d.id === id)!.status = "archived";
    },
  };
  const server = createInsecureTestServer(app, {
    admin: built.admin,
    auditLog: built.auditLog,
    identity: built.identity,
    keychain: built.keychain,
    sandboxResources: built.sandboxResources,
    sessions: built.sessions,
    loops: built.loops,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const offboard = (principal: string, body: unknown, headers: Record<string, string> = ADMIN) =>
    fetch(`${base}/v1/admin/users/${principal}/offboard`, { method: "POST", headers, body: JSON.stringify(body) });
  return { base, built, archivedApps, offboard, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("offboarding previews, then disables, revokes, archives and retires what the person owns, audited as the admin", async () => {
  const s = await start();
  try {
    const { app, keychain, sandboxResources, skills, identity } = s.built;
    const personalCron = await app.createCron({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      title: "daily digest",
      schedule: { everyMs: 60_000 },
      action: "digest",
    });
    const channelCron = await app.createCron({
      ownerScopeId: "channel:C1",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "team ping",
    });
    const othersCron = await app.createCron({
      ownerScopeId: "personal:U9",
      owner: "U9",
      createdBy: "U9",
      schedule: { everyMs: 60_000 },
      action: "noise",
    });
    const loopCron = await app.createCron({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "loop fire",
      loopId: "pending",
    });
    const { loop } = await s.built.loops.store.create({
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: "personal:U1",
      name: "inbox",
      playbook: "triage",
      successCondition: "done",
      cronId: loopCron.id,
    });
    const webhook = await app.createWebhook({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      action: "handle event",
      verification: { scheme: "hmac-sha256", secret: "webhook-secret" },
    });
    const credential = await keychain!.save({ ownerId: "U1", service: "github", secret: "fixture-secret" });
    const grant = await keychain!.createGrant({
      credentialId: credential.id,
      ownerId: "U1",
      audienceScopeId: "channel:C1",
      mode: "standing",
      purpose: "ci",
    });
    const manifest = (name: string) => ({ name, description: name, requiredCapabilities: [], body: "..." });
    const personalSkill = await skills.create({ scopeId: "personal:U1", manifest: manifest("mine"), createdBy: "U1" });
    const sharedSkill = await skills.create({ scopeId: "channel:C1", manifest: manifest("team"), createdBy: "U1" });
    const computer = await sandboxResources.create("U1", "personal:U1", "sprites", "laptop");
    await sandboxResources.setDefault("U1", "personal:U1", computer.id);

    const preview = await s.offboard("U1", {});
    assert.equal(preview.status, 200);
    const planned: any = await preview.json();
    assert.equal(planned.applied, false);
    assert.deepEqual(
      planned.changes.map((c: any) => `${c.kind}:${c.id}:${c.action}`).sort(),
      [
        `app:app-broken:archive`,
        `app:app-personal:archive`,
        `computer:${computer.id}:retire`,
        `cron:${channelCron.id}:disable_and_archive`,
        `cron:${personalCron.id}:disable_and_archive`,
        `keychain_grant:${grant.id}:revoke`,
        `loop:${loop.id}:pause`,
        `principal:U1:deactivate`,
        `skill:${personalSkill.id}:archive`,
        `webhook:${webhook.id}:disable`,
      ].sort(),
    );
    assert.equal(identity.classify("U1").type, "internal", "preview changes nothing");
    assert.equal((await app.getCron(personalCron.id))!.enabled, true);
    assert.deepEqual(s.archivedApps, []);

    const applied: any = await (await s.offboard("U1", { apply: true })).json();
    assert.equal(applied.applied, true);
    assert.deepEqual(
      applied.changes.filter((c: any) => c.result !== "done").map((c: any) => [c.id, c.error]),
      [["app-broken", "runtime destroy failed"]],
      "one failure is reported and does not stop the rest",
    );
    assert.equal(identity.classify("U1").type, "guest", "sign-in is off");
    for (const id of [personalCron.id, channelCron.id]) {
      const cron = (await app.getCron(id))!;
      assert.equal(cron.enabled, false);
      assert.equal(cron.archived, true);
    }
    assert.equal((await app.getCron(othersCron.id))!.enabled, true, "someone else's cron is untouched");
    assert.equal((await app.getWebhook(webhook.id))!.enabled, false);
    assert.equal((await s.built.loops.store.get(loop.id))!.state, "paused");
    const pausedLoopCron = (await app.getCron(loopCron.id))!;
    assert.equal(pausedLoopCron.enabled, false, "the paused loop's schedule stops too");
    assert.notEqual(pausedLoopCron.archived, true, "the loop keeps its schedule for a later resume");
    assert.equal((await keychain!.getGrant(grant.id))!.status, "revoked");
    assert.equal((await skills.get(personalSkill.id))!.status, "archived");
    assert.notEqual((await skills.get(sharedSkill.id))!.status, "archived");
    assert.deepEqual(s.archivedApps, ["app-personal"]);
    assert.equal((await sandboxResources.get(computer.id)).state, "retired");
    assert.equal(await sandboxResources.resolve("personal:U1"), null, "the default was cleared first");

    const events = await s.built.auditLog.events();
    for (const change of applied.changes)
      assert.ok(
        events.some(
          (e) =>
            e.action === `user.offboard.${change.kind}.${change.action}` &&
            e.resource === change.id &&
            e.principalId === "admin-alice" &&
            e.status === change.result &&
            e.detail === ["U1", change.error].filter(Boolean).join(": "),
        ),
        `${change.kind} ${change.id} is audited as the admin with its outcome`,
      );
    const detail: any = await (await fetch(`${s.base}/v1/admin/users/U1`, { headers: ADMIN })).json();
    assert.equal(detail.deactivated, true);
    assert.equal(applied.user.offboardedBy, "admin-alice");
    assert.equal(typeof applied.user.offboardedAt, "number");
    assert.equal(detail.user.offboardedBy, "admin-alice", "the person's page shows who offboarded them");
    const listed: any = await (await fetch(`${s.base}/v1/admin/users`, { headers: ADMIN })).json();
    const row = listed.users.find((u: any) => u.principalId === "U1");
    assert.deepEqual([row?.offboarded, row?.deactivated], [true, true], "the users list marks them");

    const again: any = await (await s.offboard("U1", {})).json();
    assert.deepEqual(
      again.changes.map((c: any) => c.id),
      ["app-broken"],
      "a second preview finds only what failed",
    );

    const reactivated = await fetch(`${s.base}/v1/admin/users/U1/reactivate`, { method: "POST", headers: ADMIN });
    assert.equal(reactivated.status, 200);
    assert.equal(identity.classify("U1").type, "internal");
    assert.equal((await app.getCron(personalCron.id))!.archived, true, "reactivation restores only sign-in");
    const after: any = await (await fetch(`${s.base}/v1/admin/users/U1`, { headers: ADMIN })).json();
    assert.equal(after.deactivated, false);
    assert.deepEqual(
      [after.user?.offboardedAt, after.user?.offboardedBy],
      [undefined, undefined],
      "reactivation clears offboarding",
    );
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "principal.reactivate"),
      "the audit log keeps the history",
    );
  } finally {
    await s.close();
  }
});

test("if the offboarding record can't be written, offboarding fails before changing anything", async () => {
  const s = await start();
  try {
    s.built.admin.users.markOffboarded = async () => {
      throw new Error("store down");
    };
    const r = await s.offboard("U1", { apply: true });
    assert.notEqual(r.status, 200);
    assert.equal(s.built.identity.classify("U1").type, "internal", "sign-in stays on");
  } finally {
    await s.close();
  }
});

test("offboarding refuses non-admins, the admin themselves, and unknown body fields", async () => {
  const s = await start();
  try {
    const denied = await s.offboard("U1", { apply: true }, { "x-admin-actor": "user-uma@default-org" });
    assert.equal(denied.status, 403);
    assert.equal(s.built.identity.classify("U1").type, "internal");
    const self = await s.offboard("admin-alice", { apply: true });
    assert.equal(self.status, 400);
    assert.equal(s.built.identity.classify("admin-alice").type, "internal");
    assert.equal((await s.offboard("U1", { apply: "yes" })).status, 400);
    assert.equal((await s.offboard("U1", { dryRun: true })).status, 400);
    await s.built.identity.deactivate("already-gone@example.com");
    const gone: any = await (await s.offboard("already-gone@example.com", {})).json();
    assert.deepEqual(gone.changes, [], "someone already deactivated by hand gets an empty plan");
    const deniedReactivate = await fetch(`${s.base}/v1/admin/users/U1/reactivate`, {
      method: "POST",
      headers: { "x-admin-actor": "user-uma@default-org" },
    });
    assert.equal(deniedReactivate.status, 403);
  } finally {
    await s.close();
  }
});
