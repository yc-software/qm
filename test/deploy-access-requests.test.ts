import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createDeploymentAccessRequests,
  renderDeploymentAccessRequests,
  type DeploymentAccessRequest,
} from "../src/deploy/access-requests.ts";
import { deployAccessMessage, registerDeployAccessActions } from "../src/slack/deploy-access.ts";
import { createControlService } from "../src/api/control-service.ts";
import type { Directory } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { scopeId, type Destination } from "../src/types.ts";

const OWNER = "alice@example.com";
const VISITOR = "mallory@example.com";
const auditLog = { record() {}, events: async () => [], tail: async () => [] };

async function fixture() {
  let now = 1_700_000_000_000;
  const acl = createAclStore();
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "h", port: 1 }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "access-")),
  });
  const deliveries: Array<{ destination: Destination; text: string; idempotencyKey: string }> = [];
  const requests = createMemoryMap<DeploymentAccessRequest>();
  const identity = createIdentityService();
  const app = createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity,
    auditLog,
    deliveries: { enqueue: async (d: (typeof deliveries)[number]) => void deliveries.push(d) },
    onDeploymentShared: (event: Parameters<typeof service.shared>[0]) => service.shared(event),
  } as unknown as Parameters<typeof createApp>[0]);
  const service = createDeploymentAccessRequests({
    requests,
    app,
    deliveries: {
      enqueue: async (d) => {
        deliveries.push(d);
      },
    },
    identity,
    appUrl: (d) => `https://${d.name ?? d.id}.apps.example.com/`,
    now: () => now,
  });
  const deployment = await app.deploy({
    ownerScopeId: scopeId("personal", OWNER),
    createdBy: OWNER,
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  const open = () =>
    service.open({
      deploymentId: deployment.id,
      appLabel: "My Site",
      appUrl: "https://mysite.apps.example.com/",
      requesterId: VISITOR,
      ownerId: OWNER,
    });
  const canReach = async (who: string) => (await app.reachDeployment(deployment.id, who)).status === "ok";
  return {
    app,
    service,
    deployment,
    deliveries,
    requests,
    open,
    canReach,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("a visitor's request is recorded once, and approving it shares the app and tells them", async () => {
  const f = await fixture();
  const first = await f.open();
  const again = await f.open();
  assert.equal(again.id, first.id, "re-asking reuses the pending request");
  assert.equal(first.status, "pending");
  assert.deepEqual(
    (await f.service.pendingFor(OWNER)).map((r) => r.id),
    [first.id],
    "the owner sees it pending",
  );
  assert.deepEqual(await f.service.pendingFor(VISITOR), [], "the requester does not");
  assert.equal(await f.service.get(first.id, VISITOR), null, "only the owner can read it");
  assert.equal(await f.canReach(VISITOR), false);

  const approved = await f.service.decide(first.id, { externalId: OWNER }, "approve");
  assert.equal(approved.status, "approved");
  assert.equal(approved.resolvedBy, OWNER);
  assert.equal(await f.canReach(VISITOR), true, "approval grants view access");
  assert.deepEqual(await f.service.pendingFor(OWNER), []);
  assert.equal(f.deliveries.length, 1, "the requester is told exactly once");
  assert.equal(f.deliveries[0]!.destination.type, "principal");
  assert.equal(f.deliveries[0]!.destination.target, VISITOR);
  assert.equal(f.deliveries[0]!.destination.onBehalfOf, OWNER);
  assert.match(f.deliveries[0]!.text, /alice@example\.com gave you access to the app "My Site"/);
  assert.match(f.deliveries[0]!.text, /https:\/\/mysite\.apps\.example\.com\//);

  const replay = await f.service.decide(first.id, { externalId: OWNER }, "decline");
  assert.equal(replay.status, "approved", "a late Decline click cannot undo an approval");
  assert.equal(f.deliveries.length, 1);
  assert.equal((await f.open()).status, "pending", "a fresh request after resolution is a new one");
});

test("declining tells the requester and grants nothing", async () => {
  const f = await fixture();
  const req = await f.open();
  const declined = await f.service.decideAs(req.id, OWNER, "decline");
  assert.equal(declined.status, "declined");
  assert.equal(await f.canReach(VISITOR), false);
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0]!.text, /declined your request for access to "My Site"/);
});

test("only the app's owner can decide", async () => {
  const f = await fixture();
  const req = await f.open();
  await assert.rejects(f.service.decideAs(req.id, VISITOR, "approve"), /Only the app's owner/);
  await assert.rejects(f.service.decide(req.id, { externalId: "bob@example.com" }, "approve"), /Only the app's owner/);
  await assert.rejects(
    f.service.decide(req.id, { externalId: OWNER, isExternalGuest: true }, "approve"),
    /Only the app's owner/,
  );
  assert.equal(await f.canReach(VISITOR), false);
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.requests.get(req.id))?.status, "pending");
});

test("sharing by hand resolves the pending request and notifies the grantee once", async () => {
  const f = await fixture();
  const req = await f.open();
  await f.app.shareDeployment(f.deployment.id, scopeId("personal", VISITOR), "read", { createdBy: OWNER });
  assert.equal((await f.requests.get(req.id))?.status, "approved");
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0]!.text, /gave you access to the app "My Site"/);
  assert.equal(f.deliveries[0]!.idempotencyKey, `deploy-access-request:${req.id}:approved`);

  await f.app.shareDeployment(f.deployment.id, scopeId("personal", "carol@example.com"), "write", { createdBy: OWNER });
  assert.equal(f.deliveries.length, 2, "an unprompted share still tells the grantee");
  assert.equal(f.deliveries[1]!.destination.target, "carol@example.com");
  assert.match(f.deliveries[1]!.text, /"mysite" \(you can also manage it\)/);
  assert.match(f.deliveries[1]!.text, /https:\/\/mysite\.apps\.example\.com\//);

  await f.app.shareDeployment(f.deployment.id, scopeId("personal", "carol@example.com"), null, { createdBy: OWNER });
  await f.app.shareDeployment(f.deployment.id, scopeId("org", "acme"), "read", { createdBy: OWNER });
  await f.app.shareDeployment(f.deployment.id, scopeId("personal", OWNER), "read", { createdBy: OWNER });
  assert.equal(f.deliveries.length, 2, "revokes, org-wide shares, and self-shares are silent");
});

test("the agent's apps share action goes through the same notification", async () => {
  const f = await fixture();
  const req = await f.open();
  const control = createControlService(f.app);
  const result = await control.shareArtifact({ type: "deploy", id: "mysite", scope: scopeId("personal", VISITOR) }, {
    actorId: OWNER,
    scopeId: scopeId("personal", OWNER),
  } as CapabilityClaims);
  assert.equal(result.ok, true);
  assert.equal((await f.requests.get(req.id))?.status, "approved");
  assert.equal(await f.canReach(VISITOR), true);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0]!.destination.target, VISITOR);
});

test("stale requests drop out of the owner's pending list", async () => {
  const f = await fixture();
  await f.open();
  f.advance(15 * 86_400_000);
  assert.deepEqual(await f.service.pendingFor(OWNER), []);
});

test("the owner's prompt lists pending requests with the exact decide call", () => {
  const block = renderDeploymentAccessRequests(
    [
      {
        id: "req-1",
        deploymentId: "d1",
        appLabel: "My Site",
        appUrl: "https://mysite.apps.example.com/",
        requesterId: VISITOR,
        ownerId: OWNER,
        createdAt: 1_000,
        status: "pending",
      },
    ],
    1_000 + 3 * 3_600_000,
  );
  assert.match(block, /### App access requests waiting on you/);
  assert.match(block, /request `req-1`: mallory@example\.com asked \(3h ago\) to open your app "My Site"/);
  assert.match(block, /\/v1\/deployment-access-requests\/<request id>\/decide/);
  assert.equal(renderDeploymentAccessRequests([]), "");
});

test("the Slack card offers Approve/Decline while pending and settles after a click", async () => {
  const f = await fixture();
  const req = await f.open();
  const pending = deployAccessMessage(req);
  assert.match(pending.text, /mallory@example\.com is asking for access to your app "My Site"/);
  const actions = pending.blocks.find((b) => b.type === "actions") as { elements: Array<{ action_id: string }> };
  assert.deepEqual(
    actions.elements.map((e) => e.action_id),
    ["deploy_access_approve", "deploy_access_decline"],
  );

  let handler: (args: any) => Promise<void> = async () => {};
  registerDeployAccessActions(
    { action: (_pattern, fn) => void (handler = fn) },
    {
      core: { deploymentAccessRequests: f.service } as SlackCoreClient,
      directory: {
        classifyActor: async (_client: unknown, id: string) => ({
          externalId: id === "UOWNER" ? OWNER : "other@example.com",
        }),
      } as unknown as Directory,
    },
  );
  const updates: Array<{ text: string; blocks: Array<{ type: string }> }> = [];
  const ephemerals: unknown[] = [];
  const client = {
    chat: {
      update: async (body: { text: string; blocks: Array<{ type: string }> }) => void updates.push(body),
      postEphemeral: async (body: unknown) => void ephemerals.push(body),
    },
  };
  const args = {
    ack: async () => {},
    body: { user: { id: "UOTHER" }, channel: { id: "D1" }, message: { ts: "1.2" } },
    action: { action_id: "deploy_access_approve", value: req.id },
    client,
  };
  await handler(args);
  assert.equal(updates.length, 0, "a stranger's click changes nothing");
  assert.equal(ephemerals.length, 1);
  assert.equal(await f.canReach(VISITOR), false);

  await handler({ ...args, body: { ...args.body, user: { id: "UOWNER" } } });
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.text, /Approved\. mallory@example\.com can now open My Site/);
  assert.ok(!updates[0]!.blocks.some((b) => b.type === "actions"), "buttons are gone once decided");
  assert.equal(await f.canReach(VISITOR), true);
});
