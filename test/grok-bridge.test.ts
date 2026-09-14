import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobStore } from "../src/grok-bridge/job-store.ts";
import { createMemorySecretVault } from "../src/grok-bridge/memory-vault.ts";
import { createPairingStore } from "../src/grok-bridge/pairing-store.ts";
import { createGrokBridge } from "../src/grok-bridge/service.ts";
import { GrokBridgeError, type JobEnvelope, type OutboundPort } from "../src/grok-bridge/types.ts";

function setup(outbound?: OutboundPort) {
  const posted: JobEnvelope[] = [];
  const projections: string[] = [];
  const members = new Set(["maya", "divyansh"]);
  const bridge = createGrokBridge({
    pairings: createPairingStore(),
    jobs: createJobStore(),
    secrets: createMemorySecretVault(),
    sessions: {
      canRead: async (_sessionId, actorId) => members.has(actorId),
      ownerIsMember: async (_sessionId, ownerId) => members.has(ownerId),
    },
    outbound: outbound ?? {
      async postJob(_url, _bearer, envelope) {
        posted.push(envelope);
        return { ok: true, status: 200 };
      },
    },
    projector: {
      async project(_job, _pairing, event) {
        projections.push(`${event.seq}:${event.status}`);
      },
    },
    now: () => 1_000,
    id: () => "id-1",
    mintToken: () => "callback-token",
  });
  return { bridge, posted, projections };
}

async function pairSara(bridge: ReturnType<typeof setup>["bridge"]) {
  const pending = await bridge.requestPairing({
    agentName: "Sara",
    ownerPrincipalId: "divyansh",
    actorId: "maya",
    actorType: "internal",
    originScopeId: "group:pipeline-review",
  });
  await bridge.decidePairing(pending.id, "divyansh", "accept");
  return bridge.completeInbound(pending.id, "divyansh", {
    webhookUrl: "https://grok.example/hook",
    webhookKey: "hook-secret",
    grokBotId: "bot-sara",
  });
}

test("guests cannot create pairings", async () => {
  const { bridge } = setup();
  await assert.rejects(
    () =>
      bridge.requestPairing({
        agentName: "sara",
        ownerPrincipalId: "divyansh",
        actorId: "guest",
        actorType: "guest",
        originScopeId: "personal:guest",
      }),
    (error: unknown) => error instanceof GrokBridgeError && error.status === 403,
  );
});

test("pairing consent then inbound credentials makes Sara dispatchable", async () => {
  const { bridge, posted } = setup();
  const paired = await pairSara(bridge);
  assert.equal(paired.status, "paired");
  assert.equal(paired.grokDisplayName, "QM · Sara");
  assert.equal(paired.consent.status, "accepted");

  const job = await bridge.dispatch({
    agentName: "sara",
    ownerPrincipalId: "divyansh",
    originSessionId: "sess-1",
    originActorId: "maya",
    actorType: "internal",
    instruction: "Pull this week's pipeline",
    callbackBaseUrl: "https://qm.example",
  });
  assert.equal(job.status, "dispatched");
  assert.equal(posted[0]?.callback_token, "callback-token");
  assert.equal(posted[0]?.callback_url, "https://qm.example/v1/grok-bridge/jobs/id-1/events");
  assert.equal("callbackTokenHash" in job, false);
});

test("events apply in order, duplicates are ignored, gaps wait", async () => {
  const { bridge, projections } = setup();
  await pairSara(bridge);
  const job = await bridge.dispatch({
    agentName: "sara",
    ownerPrincipalId: "divyansh",
    originSessionId: "sess-1",
    originActorId: "maya",
    actorType: "internal",
    instruction: "research",
    callbackBaseUrl: "https://qm.example",
  });

  const auth = "Bearer callback-token";
  await assert.rejects(
    () => bridge.ingest(job.id, { protocol: "other", job_id: job.id, seq: 1, status: "accepted", summary: "x" }, auth),
    (error: unknown) => error instanceof GrokBridgeError && error.status === 400,
  );

  const gap = await bridge.ingest(
    job.id,
    { protocol: "qm-grok-bridge/v1", job_id: job.id, seq: 2, status: "succeeded", summary: "done" },
    auth,
  );
  assert.equal(gap.duplicate, false);
  const parkedAgain = await bridge.ingest(
    job.id,
    { protocol: "qm-grok-bridge/v1", job_id: job.id, seq: 2, status: "succeeded", summary: "done" },
    auth,
  );
  assert.equal(parkedAgain.duplicate, true);
  assert.equal((await bridge.getJob(job.id, "maya")).status, "dispatched");
  assert.deepEqual(projections, []);

  await bridge.ingest(
    job.id,
    { protocol: "qm-grok-bridge/v1", job_id: job.id, seq: 1, status: "accepted", summary: "picked up" },
    auth,
  );
  const done = await bridge.getJob(job.id, "maya");
  assert.equal(done.status, "succeeded");
  assert.equal(done.summary, "done");
  assert.deepEqual(projections, ["1:accepted", "2:succeeded"]);

  const dup = await bridge.ingest(
    job.id,
    { protocol: "qm-grok-bridge/v1", job_id: job.id, seq: 1, status: "accepted", summary: "picked up" },
    auth,
  );
  assert.equal(dup.duplicate, true);
});

test("revoke fails in-flight jobs and rejects the old callback token", async () => {
  const { bridge } = setup();
  await pairSara(bridge);
  const job = await bridge.dispatch({
    agentName: "sara",
    ownerPrincipalId: "divyansh",
    originSessionId: "sess-1",
    originActorId: "maya",
    actorType: "internal",
    instruction: "research",
    callbackBaseUrl: "https://qm.example",
  });
  await bridge.revoke("id-1", "divyansh");
  await assert.rejects(
    () =>
      bridge.ingest(
        job.id,
        { protocol: "qm-grok-bridge/v1", job_id: job.id, seq: 1, status: "accepted", summary: "nope" },
        "Bearer callback-token",
      ),
    (error: unknown) => error instanceof GrokBridgeError && error.status === 401,
  );
});

test("queue refuses a 6th in-flight job and a webhook failure degrades the pairing", async () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  let n = 0;
  const limited = createGrokBridge({
    pairings: createPairingStore(),
    jobs: createJobStore(),
    secrets: createMemorySecretVault(),
    sessions: {
      canRead: async () => true,
      ownerIsMember: async () => true,
    },
    outbound: {
      async postJob() {
        return { ok: true, status: 200 };
      },
    },
    projector: { async project() {} },
    now: () => 1_000,
    id: () => ids[n++] ?? `extra-${n}`,
    mintToken: () => "callback-token",
  });
  const pairing = await pairSara(limited);
  assert.equal(pairing.status, "paired");
  for (let i = 0; i < 5; i += 1) {
    await limited.dispatch({
      agentName: "sara",
      ownerPrincipalId: "divyansh",
      originSessionId: "sess-1",
      originActorId: "maya",
      actorType: "internal",
      instruction: `job ${i}`,
      callbackBaseUrl: "https://qm.example",
    });
  }
  await assert.rejects(
    () =>
      limited.dispatch({
        agentName: "sara",
        ownerPrincipalId: "divyansh",
        originSessionId: "sess-1",
        originActorId: "maya",
        actorType: "internal",
        instruction: "overflow",
        callbackBaseUrl: "https://qm.example",
      }),
    (error: unknown) => error instanceof GrokBridgeError && error.status === 429,
  );

  const failing = setup({
    async postJob() {
      return { ok: false, status: 503 };
    },
  });
  await pairSara(failing.bridge);
  const failed = await failing.bridge.dispatch({
    agentName: "sara",
    ownerPrincipalId: "divyansh",
    originSessionId: "sess-1",
    originActorId: "maya",
    actorType: "internal",
    instruction: "research",
    callbackBaseUrl: "https://qm.example",
  });
  assert.equal(failed.status, "failed");
});

test("queued jobs reject Bearer pending", async () => {
  const ids = ["pair", "first", "second"];
  let n = 0;
  const queuedBridge = createGrokBridge({
    pairings: createPairingStore(),
    jobs: createJobStore(),
    secrets: createMemorySecretVault(),
    sessions: {
      canRead: async () => true,
      ownerIsMember: async () => true,
    },
    outbound: {
      async postJob() {
        return { ok: true, status: 200 };
      },
    },
    projector: { async project() {} },
    now: () => 1_000,
    id: () => ids[n++] ?? `extra-${n}`,
    mintToken: () => "callback-token",
  });
  await pairSara(queuedBridge);
  await queuedBridge.dispatch({
    agentName: "sara",
    ownerPrincipalId: "divyansh",
    originSessionId: "sess-1",
    originActorId: "maya",
    actorType: "internal",
    instruction: "first",
    callbackBaseUrl: "https://qm.example",
  });
  const queued = await queuedBridge.dispatch({
    agentName: "sara",
    ownerPrincipalId: "divyansh",
    originSessionId: "sess-1",
    originActorId: "maya",
    actorType: "internal",
    instruction: "second",
    callbackBaseUrl: "https://qm.example",
  });
  assert.equal(queued.status, "queued");
  await assert.rejects(
    () =>
      queuedBridge.ingest(
        queued.id,
        { protocol: "qm-grok-bridge/v1", job_id: queued.id, seq: 1, status: "accepted", summary: "forged" },
        "Bearer pending",
      ),
    (error: unknown) => error instanceof GrokBridgeError && error.status === 401,
  );
});
