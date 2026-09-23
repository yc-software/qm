import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createControlService } from "../src/api/control-service.ts";
import {
  decideDeploymentAccess,
  deployAccessMessage,
  parseDeployAccess,
  registerDeployAccessActions,
} from "../src/slack/deploy-access.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { scopeId, type ActorAssertion, type Permission } from "../src/types.ts";

const owner = "alice@example.com";
const requester = "bob@example.com";
const person = (id: string) => scopeId("personal", id);
const publishInput = (id = owner, name = "mysite") => ({
  ownerScopeId: person(id),
  createdBy: id,
  entrypoint: "x",
  files: [],
  name,
});
const request = { deploymentId: "00000000-0000-4000-8000-000000000001", requesterId: requester };

async function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-access-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const deliveries = createDeliveryStore();
  const deploy = createDeployService({
    deliveries,
    deployAppsDomain: "apps.example.com",
    deployStore: createDeployStore(),
    acl,
    auditLog,
    deployDir: dir,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "h", port: 1 }),
      destroy: async () => {},
    },
  });
  const identity = createIdentityService();
  const directory = createDirectoryStore();
  const app = createApp({
    deploy,
    acl,
    identity,
    deliveries,
    auditLog,
    directory,
    sessions: createMemorySessionStore(),
    deployAppsDomain: "apps.example.com",
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy(publishInput());
  const value = JSON.stringify({ deploymentId: d.id, requesterId: requester });
  const share = (permission: Permission | null, scope = person(requester)) =>
    app.shareDeployment(d.id, scope, permission, { createdBy: owner });
  return {
    share,
    grants: () => app.deploymentGrantees(d.id),
    notices: () => deliveries.pending("principal"),
    app,
    deploy,
    identity,
    deliveries,
    directory,
    d,
    value,
    auditLog,
    decide: (id = owner, approve = true, extra: Partial<ActorAssertion> = {}) =>
      decideDeploymentAccess(app, identity, value, { externalId: id, ...extra }, approve),
  };
}

test("card is plain text with only deployment and requester in bounded JSON buttons", () => {
  const text = '<@everyone> asks to open "A & B"';
  const card = deployAccessMessage(request, text);
  assert.equal(card.text, text);
  assert.deepEqual(card.blocks[0], { type: "section", text: { type: "plain_text", text } });
  const buttons = card.blocks[1]!.elements as Array<{ action_id: string; value: string }>;
  assert.deepEqual(
    buttons.map((b) => b.action_id),
    ["deploy_access_approve", "deploy_access_decline"],
  );
  for (const b of buttons) {
    assert.ok(b.value.length <= 2000);
    assert.deepEqual(parseDeployAccess(b.value), request);
  }
});

test("malformed or scope-injecting button payloads are rejected", () => {
  for (const value of [
    "",
    "null",
    "[]",
    "x".repeat(2001),
    "{}",
    JSON.stringify({ ...request, permission: "write" }),
    JSON.stringify({ ...request, deploymentId: "mysite" }),
    JSON.stringify({ ...request, requesterId: "personal:bob" }),
    JSON.stringify({ ...request, requesterId: "<@everyone>" }),
    JSON.stringify({ ...request, requesterId: "bob\n" }),
    JSON.stringify({ ...request, requesterId: 42 }),
    JSON.stringify({ ...request, requesterId: "x".repeat(321) }),
  ])
    assert.throws(() => parseDeployAccess(value));
});

test("approve is audited and idempotent, preserves manage access, and respects transfers/revokes", async (t) => {
  const f = await fixture(t);
  assert.match(await f.decide(), /^Approved\./);
  await f.decide();
  assert.deepEqual(await f.grants(), [{ scope: person(requester), permission: "read" }]);
  const notices = await f.notices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.destination.target, requester);
  assert.match(notices[0]!.text, /gave you access.*https:\/\/mysite.apps.example.com\//);
  assert.ok((await f.auditLog.events()).some((e) => e.action === "grant"));
  await f.share(null);
  assert.deepEqual(await f.grants(), []);
  await assert.rejects(f.decide(requester), /owner/);
  await f.decide();
  assert.equal((await f.grants()).length, 1);
  assert.equal((await f.notices()).length, 1);
  await f.share("write");
  await f.decide();
  assert.deepEqual(await f.grants(), [{ scope: person(requester), permission: "write" }]);
  assert.equal((await f.notices()).length, 2);
  await f.app.moveArtifactHome("deploy", f.d.id, person(requester), owner);
  await assert.rejects(f.decide(), /owner/);
  await assert.rejects(f.decide(owner, false), /owner/);
});

test("requester, stranger, guest and deactivated owner cannot approve or decline", async (t) => {
  const f = await fixture(t);
  for (const approve of [true, false]) {
    for (const id of [requester, "carol@example.com"]) await assert.rejects(f.decide(id, approve), /owner/);
    await assert.rejects(f.decide(owner, approve, { isExternalGuest: true }), /owner/);
  }
  await f.identity.deactivate(owner);
  await assert.rejects(f.decide(), /owner/);
  await assert.rejects(f.decide(owner, false), /owner/);
  assert.deepEqual(await f.grants(), []);
  assert.deepEqual(await f.notices(), []);
});

test("tampering the deployment ID cannot authorize another owner's app", async (t) => {
  const f = await fixture(t);
  const other = await f.app.deploy(publishInput(requester, "other"));
  const value = JSON.stringify({ ...request, deploymentId: other.id });
  for (const approve of [true, false])
    await assert.rejects(decideDeploymentAccess(f.app, f.identity, value, { externalId: owner }, approve), /owner/);
});

test("decline only notifies and leaves access unchanged; duplicate clicks dedupe", async (t) => {
  const f = await fixture(t);
  assert.match(await f.decide(owner, false), /^Declined\./);
  await f.decide(owner, false);
  assert.deepEqual(await f.grants(), []);
  const notices = await f.notices();
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /declined your request/);
});

test("direct share paths notify only after successful grants; org, self and revoke stay silent", async (t) => {
  const f = await fixture(t);
  await f.share(null);
  await f.share("read", person(owner));
  await f.share("read", scopeId("org", "acme"));
  const control = createControlService(f.app);
  const cap = (actorId: string) => ({ actorId, scopeId: person(actorId), liveActor: true }) as CapabilityClaims;
  const request = { type: "deploy" as const, id: f.d.id, scope: person(requester) };
  assert.equal((await control.shareArtifact(request, cap(requester))).ok, false);
  assert.deepEqual(await f.notices(), []);
  assert.equal((await control.shareArtifact(request, cap(owner))).ok, true);
  await f.share("read");
  assert.equal((await f.notices()).length, 1);
  f.deliveries.enqueue = async () => {
    throw new Error("outbox unavailable");
  };
  assert.equal((await f.share("write")).find((g) => g.scope === person(requester))?.permission, "write");
});

test("button dispatch classifies the clicker, settles the card, and keeps failed cards actionable", async (t) => {
  const f = await fixture(t);
  let handler!: (a: any) => Promise<void>;
  let acked = 0;
  const updates: any[] = [];
  const errors: any[] = [];
  registerDeployAccessActions(
    {
      action: (_p, h) => {
        handler = h;
      },
    },
    {
      directory: { classifyActor: async (_c: unknown, id: string) => ({ externalId: id }) } as never,
      core: {
        decideDeploymentAccess: (value: string, actor: ActorAssertion, approve: boolean) =>
          decideDeploymentAccess(f.app, f.identity, value, actor, approve),
      } as never,
    },
  );
  const click = (id: string) =>
    handler({
      ack: async () => void acked++,
      body: { user: { id }, channel: { id: "D1" }, message: { ts: "1.1" } },
      action: { action_id: "deploy_access_approve", value: f.value },
      client: {
        chat: {
          update: async (d: any) => void updates.push(d),
          postEphemeral: async (d: any) => void errors.push(d),
        },
      },
    });
  await click(requester);
  assert.equal(updates.length, 0);
  assert.equal(errors.length, 1);
  await click(owner);
  assert.equal(acked, 2);
  assert.match(updates[0].text, /^Approved\./);
  assert.equal(
    updates[0].blocks.some((b: any) => b.type === "actions"),
    false,
  );
});

test("shared-home members can approve and decline, outsiders cannot", async (t) => {
  const f = await fixture(t);
  await f.directory.upsertGroup("G1", [owner, "carol@example.com"]);
  await f.app.moveArtifactHome("deploy", f.d.id, scopeId("group", "G1"), owner);
  assert.match(await f.decide("carol@example.com", false), /^Declined\./);
  assert.match(await f.decide("carol@example.com"), /^Approved\./);
  await assert.rejects(f.decide(requester, false), /owner/);
});

test("publish audiences notify once with final permissions, including subsequent direct shares", async (t) => {
  const f = await fixture(t);
  const d = await f.deploy.deployOrUpdate({
    ...publishInput(owner, "published"),
    share: [{ scope: person(requester), permission: "write" }],
    defaultAudience: {
      contextScopeId: person(owner),
      granteeScopeIds: [person(requester), person("carol@example.com")],
      snapshotAt: Date.now(),
    },
  });
  const notices = await f.notices();
  assert.equal(notices.length, 2);
  const toRequester = notices.filter((n) => n.destination.target === requester);
  assert.equal(toRequester.length, 1);
  assert.match(toRequester[0]!.text, /manage it.*https:\/\/published.apps.example.com\//);
  const value = JSON.stringify({ deploymentId: d.id, requesterId: requester });
  await decideDeploymentAccess(f.app, f.identity, value, { externalId: owner }, true);
  await f.app.shareDeployment(d.id, person(requester), "write", { createdBy: owner });
  assert.equal((await f.notices()).length, 2);
});
