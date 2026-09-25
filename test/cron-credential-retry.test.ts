import { test } from "node:test";
import assert from "node:assert/strict";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAskExpirySweep, fireAskResolution, type AskResolutionDeps } from "../src/triggers/keychain-ask.ts";
import { createKeychain, type KeychainAsk } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { TurnRequest, TurnResult } from "../src/types.ts";

async function fixture(run: (request: TurnRequest) => Promise<TurnResult>) {
  const crons = createCronStore();
  const cron = await crons.create({
    owner: "U_ALICE",
    createdBy: "U_ALICE",
    ownerScopeId: "personal:U_ALICE",
    schedule: { everyMs: 60_000 },
    action: "read a private dummy account",
    runtime: { harnessId: "pi", modelId: "gpt-6-luna", effortLevel: "low" },
    destination: {
      type: "principal",
      target: "U_BOB",
      audienceScopeId: "personal:U_BOB",
      onBehalfOf: "U_ALICE",
    },
    recipientConsent: { recipientId: "U_BOB", status: "declined" },
  });
  const deliveries = createDeliveryStore();
  const idempotency = createIdempotencyStore();
  const ask: KeychainAsk = {
    id: "retry-ask",
    credentialId: "dummy-credential",
    ownerId: "U_ALICE",
    requesterId: "U_ALICE",
    orgId: "test",
    requesterScopeId: "personal:U_ALICE",
    requesterThreadRef: `cron:${cron.id}:fire:123456789abc`,
    requesterDestination: cron.destination,
    purpose: "read a private dummy account",
    status: "approved",
    grantId: "dummy-grant",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  const deps: AskResolutionDeps = {
    deliveries,
    idempotency,
    identity: createIdentityService(),
    getCron: (id) => crons.get(id),
    run,
  };
  return { crons, cron, deliveries, idempotency, ask, deps };
}

test("busy cron credential resolution leaves its fire retryable and resumes exactly once when available", async () => {
  const requests: TurnRequest[] = [];
  const f = await fixture(async (request) => {
    requests.push(request);
    return requests.length === 1
      ? { status: "refused", refusalKind: "session_busy", reason: "conversation is busy" }
      : { status: "ok", reply: "dummy scheduled result" };
  });
  await f.crons.setRecipientConsent(f.cron.id, { recipientId: "U_BOB", status: "accepted" });
  const fireKey = `ask:${f.ask.id}:approved`;

  await assert.rejects(fireAskResolution(f.deps, f.ask));

  assert.equal(requests[0]?.model, "gpt-6-luna");
  assert.equal(requests[0]?.thinkingLevel, "low");
  assert.equal(await f.idempotency.committed(fireKey), false);
  assert.equal((await f.deliveries.pending("principal")).length, 0);
  const resumed = await fireAskResolution(f.deps, f.ask);
  assert.equal(resumed.status, "ok");
  assert.equal(await f.idempotency.committed(fireKey), true);
  await fireAskResolution(f.deps, f.ask);

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.conversation.threadRef === f.ask.requesterThreadRef));
  assert.ok(requests.every((request) => request.triggered === true));
  const pending = await f.deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_BOB");
  assert.equal(pending[0]!.text, "dummy scheduled result");
});

test("failed cron credential resolution notifies only the owner even when its recipient declined delivery", async () => {
  let runs = 0;
  const f = await fixture(async () => {
    runs++;
    return { status: "failed", reason: "model unavailable" };
  });

  const failed = await fireAskResolution(f.deps, f.ask);
  await fireAskResolution(f.deps, f.ask);

  assert.equal(failed.status, "failed");
  assert.equal(runs, 1);
  const pending = await f.deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_ALICE");
  assert.equal(pending[0]!.destination.audienceScopeId, "personal:U_ALICE");
  assert.match(pending[0]!.text, /couldn't resume the task automatically/);
  assert.match(pending[0]!.text, /retry-ask/);
  assert.equal(pending.filter((delivery) => delivery.destination.target === "U_BOB").length, 0);
});

test("a concurrent sweep cannot mark an in-flight busy resume notified before it becomes retryable", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<TurnResult>();
  let runs = 0;
  const f = await fixture(async () => {
    runs++;
    if (runs > 1) return { status: "ok", reply: "dummy scheduled result" };
    entered.resolve();
    return release.promise;
  });
  await f.crons.setRecipientConsent(f.cron.id, { recipientId: "U_BOB", status: "accepted" });
  const asks = createMemoryMap<KeychainAsk>();
  await asks.put(f.ask.id, f.ask);
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks,
    key: deriveConnectorKey("concurrent-cron-resume-test"),
  });
  const sweep = createAskExpirySweep({ keychain, fire: (ask) => fireAskResolution(f.deps, ask) });
  const initial = assert.rejects(fireAskResolution(f.deps, f.ask), /waiting for the original conversation/);
  await entered.promise;

  await sweep(Date.now());
  assert.equal((await keychain.getAsk(f.ask.id))?.notifiedAt, undefined);
  release.resolve({ status: "refused", refusalKind: "session_busy", reason: "conversation is busy" });
  await initial;
  assert.equal(await f.idempotency.committed(`ask:${f.ask.id}:approved`), false);

  await sweep(Date.now());
  await sweep(Date.now());

  assert.equal(runs, 2);
  assert.notEqual((await keychain.getAsk(f.ask.id))?.notifiedAt, undefined);
  assert.equal(await f.idempotency.committed(`ask:${f.ask.id}:approved`), true);
  const pending = await f.deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_BOB");
});
