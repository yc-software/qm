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
  await built.identity.hydrate();
  const deployments = [
    deployment("app-personal", "personal:U1", "U1"),
    deployment("app-shared", "channel:C1", "U1"),
    deployment("app-other", "personal:U9", "U9"),
  ];
  const archivedApps: string[] = [];
  const app = {
    ...built.app,
    listDeployments: async () => deployments,
    archiveDeployment: async (id: string) => {
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
        `app:app-personal:archive`,
        `computer:${computer.id}:retire`,
        `cron:${channelCron.id}:disable_and_archive`,
        `cron:${personalCron.id}:disable_and_archive`,
        `keychain_grant:${grant.id}:revoke`,
        `sign_in:U1:deactivate`,
        `skill:${personalSkill.id}:archive`,
        `webhook:${webhook.id}:disable`,
      ].sort(),
    );
    assert.deepEqual(
      planned.kept.map((k: any) => `${k.kind}:${k.id}`).sort(),
      [`app:app-shared`, `credential:${credential.id}`, `skill:${sharedSkill.id}`].sort(),
    );
    assert.equal(identity.classify("U1").type, "internal", "preview changes nothing");
    assert.equal((await app.getCron(personalCron.id))!.enabled, true);
    assert.deepEqual(s.archivedApps, []);

    const applied: any = await (await s.offboard("U1", { apply: true })).json();
    assert.equal(applied.applied, true);
    assert.deepEqual(
      applied.changes.filter((c: any) => c.result !== "done"),
      [],
    );
    assert.equal(identity.classify("U1").type, "guest", "sign-in is off");
    for (const id of [personalCron.id, channelCron.id]) {
      const cron = (await app.getCron(id))!;
      assert.equal(cron.enabled, false);
      assert.equal(cron.archived, true);
    }
    assert.equal((await app.getCron(othersCron.id))!.enabled, true, "someone else's cron is untouched");
    assert.equal((await app.getWebhook(webhook.id))!.enabled, false);
    assert.equal((await keychain!.getGrant(grant.id))!.status, "revoked");
    assert.equal((await skills.get(personalSkill.id))!.status, "archived");
    assert.notEqual((await skills.get(sharedSkill.id))!.status, "archived");
    assert.deepEqual(s.archivedApps, ["app-personal"]);
    assert.equal((await sandboxResources.get(computer.id)).state, "retired");
    assert.equal(await sandboxResources.resolve("personal:U1"), null, "the default was cleared first");

    const events = await s.built.auditLog.events();
    const offboardEvents = events.filter((e) => e.action.startsWith("offboard."));
    assert.equal(offboardEvents.length, applied.changes.length);
    assert.ok(offboardEvents.every((e) => e.principalId === "admin-alice"));
    assert.ok(events.some((e) => e.action === "user.offboard" && e.principalId === "admin-alice"));

    const again: any = await (await s.offboard("U1", {})).json();
    assert.deepEqual(again.changes, [], "a second preview finds nothing left to do");

    const reactivated = await fetch(`${s.base}/v1/admin/users/U1/reactivate`, { method: "POST", headers: ADMIN });
    assert.equal(reactivated.status, 200);
    assert.equal(identity.classify("U1").type, "internal");
    assert.equal((await app.getCron(personalCron.id))!.archived, true, "reactivation restores only sign-in");
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
    const deniedReactivate = await fetch(`${s.base}/v1/admin/users/U1/reactivate`, {
      method: "POST",
      headers: { "x-admin-actor": "user-uma@default-org" },
    });
    assert.equal(deniedReactivate.status, 403);
  } finally {
    await s.close();
  }
});
