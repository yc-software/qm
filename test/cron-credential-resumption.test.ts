import { test } from "node:test";
import assert from "node:assert/strict";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { fireAskResolution, type AskResolutionDeps } from "../src/triggers/keychain-ask.ts";
import type { KeychainAsk } from "../src/credentials/keychain.ts";
import type { Cron, Destination, TurnRequest } from "../src/types.ts";

const recipient: Destination = {
  type: "principal",
  target: "U_BOB",
  audienceScopeId: "personal:U_BOB",
  onBehalfOf: "U_ALICE",
};

async function fixture() {
  const crons = createCronStore();
  const cron = await crons.create({
    owner: "U_ALICE",
    createdBy: "U_ALICE",
    ownerScopeId: "personal:U_ALICE",
    schedule: { everyMs: 60_000 },
    action: "read the dummy account and report the result",
    destination: recipient,
  });
  const deliveries = createDeliveryStore();
  const requests: TurnRequest[] = [];
  const deps: AskResolutionDeps = {
    deliveries,
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    getCron: (id) => crons.get(id),
    run: async (request) => {
      requests.push(request);
      return { status: "ok", reply: "dummy scheduled result" };
    },
  };
  const ask: KeychainAsk = {
    id: "dummy-ask",
    credentialId: "dummy-credential",
    ownerId: "U_ALICE",
    requesterId: "U_ALICE",
    orgId: "test",
    requesterScopeId: "personal:U_ALICE",
    requesterThreadRef: `cron:${cron.id}:fire:123456789abc`,
    requesterDestination: recipient,
    purpose: cron.action!,
    status: "approved",
    grantId: "dummy-grant",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  return { crons, cron, deps, ask, deliveries, requests };
}

test("cron credential approval resumes the original fire once and delivers to the current destination", async () => {
  const f = await fixture();
  const destination: Destination = {
    type: "principal",
    target: "U_CAROL",
    audienceScopeId: "personal:U_CAROL",
    onBehalfOf: "U_ALICE",
  };
  await f.crons.setDestination(f.cron.id, destination);
  await f.crons.update(f.cron.id, { unattendedGrants: ["allowed-job-grant"] });

  await fireAskResolution(f.deps, f.ask);
  await fireAskResolution(f.deps, f.ask);

  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.triggered, true);
  assert.equal(request.actor.externalId, "U_ALICE");
  assert.equal(request.conversation.threadRef, f.ask.requesterThreadRef);
  assert.deepEqual(request.triggerDestination, destination);
  assert.equal(request.unattendedGrants, undefined, "grants never ride a fire that delivers to another person");
  assert.match(request.text, /approved access until revoked/);
  assert.ok(!request.text.includes(f.ask.id) && !request.text.includes(f.ask.purpose));
  const pending = await f.deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_CAROL");
  assert.equal(pending[0]!.text, "dummy scheduled result");
  assert.equal(pending[0]!.provenance?.sourceThreadRef, f.ask.requesterThreadRef);
});

for (const changed of ["missing", "archived", "scope", "owner"] as const) {
  test(`cron credential approval fails closed when the original cron is ${changed}`, async () => {
    const f = await fixture();
    if (changed === "missing") await f.crons.delete(f.cron.id);
    else if (changed === "archived") await f.crons.update(f.cron.id, { archived: true });
    else {
      const current: Cron = {
        ...f.cron,
        ...(changed === "scope" ? { ownerScopeId: "personal:U_BOB" as const } : { owner: "U_BOB" }),
      };
      f.deps.getCron = async () => current;
    }

    const outcome = await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.ran, false);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.deliveries.pending("principal")).length, 0);
  });
}

test("cron credential approval fails closed when no cron lookup is available", async () => {
  const f = await fixture();
  delete f.deps.getCron;

  const outcome = await fireAskResolution(f.deps, f.ask);

  assert.equal(outcome.ran, false);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.deliveries.pending("principal")).length, 0);
});

test("cron credential approval does not restore a removed delivery destination", async () => {
  const f = await fixture();
  await f.crons.setDestination(f.cron.id, undefined);

  await fireAskResolution(f.deps, f.ask);

  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.triggerDestination, undefined);
  assert.equal((await f.deliveries.pending("principal")).length, 0);
});

for (const schedule of [{ everyMs: 60_000 }, { cron: "0 9 * * *", timezone: "UTC" }]) {
  test(`cron credential approval does not resume a paused recurring job (${JSON.stringify(schedule)})`, async () => {
    const f = await fixture();
    await f.crons.update(f.cron.id, { schedule });
    await f.crons.setEnabled(f.cron.id, false);

    const outcome = await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.ran, false);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.deliveries.pending("principal")).length, 0);
  });
}

test("cron credential approval resumes a disabled one-shot job in its original fire", async () => {
  const f = await fixture();
  await f.crons.update(f.cron.id, { schedule: { firstFireAt: Date.now() + 60_000 } });
  await f.crons.setEnabled(f.cron.id, false);

  const outcome = await fireAskResolution(f.deps, f.ask);

  assert.equal(outcome.ran, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.conversation.threadRef, f.ask.requesterThreadRef);
  assert.equal((await f.deliveries.pending("principal")).length, 1);
});
