import { test } from "node:test";
import assert from "node:assert/strict";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createKeychain, KeychainError, ASK_TTL_MS } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { fireAskResolution, type AskResolutionDeps } from "../src/triggers/keychain-ask.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import type { Principal, ScopeId, TurnRequest } from "../src/types.ts";

function keychain(now = Date.now) {
  return createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("shared-credential-resumption-test"),
    now,
  });
}

async function fixture(scope: ScopeId = "channel:C_SHARED") {
  const k = keychain();
  const credential = await k.save({
    ownerId: "U_CREDENTIAL_OWNER",
    service: "dummy",
    secret: "dummy-only-secret",
    envKey: "DUMMY_TOKEN",
  });
  const crons = createCronStore();
  const cron = await crons.create({
    owner: "U_JOB_OWNER",
    createdBy: "U_JOB_OWNER",
    ownerScopeId: scope,
    runAs: "scopeFloor",
    members: [{ id: "U_JOB_OWNER", type: "internal" }],
    unattendedGrants: ["private-owner-grant"],
    schedule: { everyMs: 60_000 },
    action: "read the dummy account",
    destination: {
      type: "principal",
      target: "U_REQUESTER",
      audienceScopeId: "personal:U_REQUESTER",
      onBehalfOf: "U_JOB_OWNER",
    },
    recipientConsent: { recipientId: "U_REQUESTER", status: "accepted" },
  });
  const state: { members: Principal[] } = { members: [{ id: "U_REQUESTER", type: "internal" }] };
  const requests: TurnRequest[] = [];
  const deliveries = createDeliveryStore();
  const deps: AskResolutionDeps = {
    deliveries,
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    currentScopeMembers: async () => state.members,
    getCron: (id) => crons.get(id),
    getGrant: (id) => k.getGrant(id),
    run: async (request) => {
      requests.push(request);
      return request.surface === "cron" ? { status: "silent" } : { status: "ok", reply: "dummy result" };
    },
  };
  await deps.identity.deactivate(cron.owner);
  const threadRef = `cron:${cron.id}:fire:first`;
  await runTrigger(deps, {
    ...cron,
    input: cron.action!,
    fireKey: "original-fire",
    threadRef,
    surface: "cron",
    recipientConsentRequired: true,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.actor.externalId, "U_REQUESTER");
  const { ask } = await k.createAsk({
    credentialId: credential.id,
    requesterId: requests[0]!.actor.externalId,
    requesterScopeId: scope,
    requesterThreadRef: requests[0]!.conversation.threadRef,
    requesterDestination: requests[0]!.triggerDestination,
    triggered: true,
    purpose: cron.action!,
  });
  const approved = await k.approveAsk({
    askId: ask.id,
    ownerId: credential.ownerId,
    mode: "once",
    purpose: "read only the dummy account",
  });
  requests.length = 0;
  return { k, credential, crons, cron, state, requests, deliveries, deps, ...approved };
}

for (const scope of ["channel:C_SHARED", "group:G_SHARED", "group:web-project-shared"] as const) {
  test(`scopeFloor approval resumes another person's credential in ${scope} after the job owner departs`, async () => {
    const f = await fixture(scope);

    const outcome = await fireAskResolution(f.deps, f.ask);
    await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.status, "ok");
    assert.equal(f.requests.length, 1);
    const request = f.requests[0]!;
    assert.equal(request.actor.externalId, "U_REQUESTER");
    assert.equal(request.triggered, true);
    assert.equal(request.conversation.threadRef, f.ask.requesterThreadRef);
    assert.equal(request.conversation.kind, scope.startsWith("channel:") ? "channel" : "group");
    assert.equal(request.conversation.channelRef, scope.slice(scope.indexOf(":") + 1));
    assert.deepEqual(request.conversation.audience, [{ externalId: "U_REQUESTER" }]);
    assert.equal(request.unattendedGrants, undefined);
    assert.equal(request.ownerKeychainUnion, undefined);
    assert.deepEqual(request.triggerDestination, f.cron.destination);
    assert.match(request.text, /read only the dummy account/);
    assert.ok(request.text.includes(f.grant.id));
    assert.equal(f.grant.audienceScopeId, scope);
    assert.equal(f.grant.ownerId, "U_CREDENTIAL_OWNER");
    await assert.rejects(
      f.k.materialize(f.grant.id, "channel:C_OTHER", request.actor.externalId),
      (error: KeychainError) => error.status === 403,
    );
    const materialized = await f.k.materialize(f.grant.id, scope, request.actor.externalId);
    assert.ok(materialized.kind === "env" && materialized.env[0]!.value === "dummy-only-secret");
    await assert.rejects(
      f.k.materialize(f.grant.id, scope, request.actor.externalId),
      (error: KeychainError) => error.status === 410,
    );
    const pending = await f.deliveries.pending("principal");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.destination.target, "U_REQUESTER");
  });
}

test("scopeFloor approval reselects the current actor when the original requester also departed", async () => {
  const f = await fixture();
  f.state.members = [{ id: "U_NEW_MEMBER", type: "internal" }];
  await f.deps.identity.deactivate("U_REQUESTER");

  await fireAskResolution(f.deps, f.ask);

  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.actor.externalId, "U_NEW_MEMBER");
});

test("scopeFloor approval selects the stored job owner again when they return", async () => {
  const f = await fixture();
  await f.deps.identity.reactivate(f.cron.owner);
  f.state.members = [
    { id: "U_REQUESTER", type: "internal" },
    { id: f.cron.owner, type: "internal" },
  ];

  await fireAskResolution(f.deps, f.ask);

  assert.equal(f.requests[0]!.actor.externalId, f.cron.owner);
});

for (const members of [[], [{ id: "U_JOB_OWNER", type: "internal" as const }]]) {
  test(`scopeFloor approval fails closed with no active internal member (${members.length} stale members)`, async () => {
    const f = await fixture();
    f.state.members = members;

    const outcome = await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.authzFailed, true);
    assert.equal(outcome.ran, false);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.deliveries.pending("principal")).length, 0);
    assert.equal((await f.k.getGrant(f.grant.id))?.status, "active");
  });
}

test("substituted scopeFloor requester still needs recipient consent for delivery to themselves", async () => {
  const f = await fixture();
  await f.crons.setRecipientConsent(f.cron.id, { recipientId: "U_REQUESTER", status: "declined" });

  const outcome = await fireAskResolution(f.deps, f.ask);

  assert.equal(outcome.status, "refused");
  assert.equal(f.requests.length, 1);
  const pending = await f.deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_JOB_OWNER");
  assert.ok(pending.every((delivery) => !delivery.idempotencyKey?.endsWith(":fallback")));
});

for (const runAs of ["owner", "scopeShared"] as const) {
  test(`approval cannot substitute a requester after the cron changes to ${runAs}`, async () => {
    const f = await fixture();
    await f.crons.update(f.cron.id, { runAs });

    const outcome = await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.authzFailed, true);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.deliveries.pending("principal")).length, 0);
  });
}

for (const scope of ["channel:C_SHARED", "group:G_SHARED", "group:web-project-shared"] as const) {
  test(`shared asks in ${scope} deduplicate by job across actors and keep live requests separate`, async () => {
    let now = 1_000_000;
    const k = keychain(() => now++);
    const credential = await k.save({ ownerId: "U_OWNER", service: "dummy", secret: "fake", envKey: "DUMMY_TOKEN" });
    const base = {
      credentialId: credential.id,
      requesterId: "U_OWNER",
      requesterScopeId: scope,
      purpose: "read dummy account",
      triggered: true,
    };
    const first = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:one" });
    const second = await k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:one" });
    const live = await k.createAsk({ ...base, triggered: false, requesterThreadRef: "live-thread" });
    assert.equal(new Set([first.ask.id, second.ask.id, live.ask.id]).size, 3);
    const retry = await k.createAsk({ ...base, requesterId: "U_OTHER", requesterThreadRef: "cron:first:fire:two" });
    assert.equal(retry.existing, true);
    assert.equal(retry.ask.id, first.ask.id);
    assert.equal(retry.ask.requesterThreadRef, first.ask.requesterThreadRef);
    await k.declineAsk({ askId: first.ask.id, ownerId: "U_OWNER" });
    await k.approveAsk({ askId: live.ask.id, ownerId: "U_OWNER", mode: "once", purpose: "live use only" });
    await assert.rejects(
      k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:three" }),
      (error: KeychainError) => error.status === 409,
    );
    const revived = await k.createAsk({ ...base, triggered: false, requesterThreadRef: "cron:first:fire:four" });
    assert.notEqual(revived.ask.id, first.ask.id);
    assert.equal((await k.getAsk(second.ask.id))?.status, "pending");
    now += ASK_TTL_MS + 1;
    await assert.rejects(
      k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:two" }),
      (error: KeychainError) => error.status === 409,
    );
  });
}
