import { TEST_FINNY_EVALUATOR, testDeterministicAuthority } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mintSignedPayload, verifySignedPayload } from "../src/auth/signed-token.ts";
import { createFinnyFinalizer, createSignedFinnyFinalizer } from "../src/finny/finalizer.ts";
import { FINNY_CHECK_IDS, initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import type { FinnyStore } from "../src/finny/store.ts";
import type { FinnyApprovalAction, FinnyCheckId } from "../src/finny/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "finny-finalizer-test-secret";

async function createApprovedJob(store: FinnyStore, action: FinnyApprovalAction = "approve") {
  const input = {
    id: randomUUID(),
    scopeId: "personal:U1",
    plan: {
      title: "Finance pack",
      phases: [{ name: "Prepare", owner: "MIS Expert", dependencies: [] }],
      certification: "Independent checks",
      deliverable: "Workbook",
      destination: "Origin thread",
      clarifications: [],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    originThreadRef: `slack:C1:${randomUUID()}`,
    findingPolicy: {
      id: "finny-r5-test",
      maxFindings: 8,
      maxCodeLength: 80,
      maxMessageLength: 2_000,
    },
  };
  const created = await store.createJob(input);
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    authorizedActorId: "U1",
  });
  await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action,
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  const artifactDigest = `artifact-${randomUUID()}`;
  const provisionalRevision = `revision-${randomUUID()}`;
  if (action === "approve") {
    await store.recordArtifactReady({
      scopeId: input.scopeId,
      jobId: input.id,
      artifactDigest,
      provisionalRevision,
      idempotencyKey: randomUUID(),
    });
  }
  return { ...created, artifactDigest, provisionalRevision };
}

async function attest(
  store: FinnyStore,
  job: Awaited<ReturnType<typeof createApprovedJob>>,
  checkId: FinnyCheckId,
  verdict: "pass" | "block" = "pass",
) {
  return store.recordAttestation({
    id: randomUUID(),
    scopeId: job.scopeId,
    jobId: job.id,
    checkId,
    generation: job.policy.requiredGenerations[checkId],
    verdict,
    evidenceDigest: `evidence-${randomUUID()}`,
    artifactDigest: job.artifactDigest,
    issuerPrincipalId: "U-auditor",
    issuerRunId: "run-auditor-1",
    ...testDeterministicAuthority(checkId, verdict, job.policy.evaluator),
    idempotencyKey: randomUUID(),
  });
}

async function passChecks(
  store: FinnyStore,
  job: Awaited<ReturnType<typeof createApprovedJob>>,
  checks: readonly FinnyCheckId[] = FINNY_CHECK_IDS,
) {
  for (const checkId of checks) await attest(store, job, checkId);
}

test("finalizer reads authoritative state and returns the same signed receipt for one idempotency key", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const job = await createApprovedJob(store);
  await passChecks(store, job);
  const finalizer = createSignedFinnyFinalizer(store, SECRET);
  const idempotencyKey = randomUUID();
  const receipt = await finalizer.finalize({ scopeId: job.scopeId, jobId: job.id, idempotencyKey });
  assert.deepEqual(await verifySignedPayload(receipt.token, SECRET), receipt.payload);
  assert.equal(receipt.payload.jobId, job.id);
  assert.equal(receipt.payload.planDigest, job.planDigest);
  assert.equal(receipt.payload.artifactDigest, job.artifactDigest);
  assert.deepEqual(receipt.payload.evaluator, job.policy.evaluator);
  assert.equal(receipt.payload.provisionalRevision, job.provisionalRevision);
  const replay = await finalizer.finalize({ scopeId: job.scopeId, jobId: job.id, idempotencyKey });
  assert.deepEqual(replay, receipt);
  await assert.rejects(
    finalizer.finalize({ scopeId: job.scopeId, jobId: job.id, idempotencyKey: randomUUID() }),
    /different idempotency/i,
  );
  const stored = await store.getJob(job.scopeId, job.id);
  assert.ok(stored?.approval?.consumedAt);
  assert.deepEqual(stored?.finalReceipt, receipt);
});

test("finalizer rejects missing evidence and the latest BLOCK", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const missing = await createApprovedJob(store);
  await passChecks(store, missing, FINNY_CHECK_IDS.slice(0, -1));
  const finalizer = createSignedFinnyFinalizer(store, SECRET);
  await assert.rejects(
    finalizer.finalize({ scopeId: missing.scopeId, jobId: missing.id, idempotencyKey: randomUUID() }),
    /missing.*lineage\.binding/i,
  );

  const blocked = await createApprovedJob(store);
  await passChecks(store, blocked);
  await attest(store, blocked, "financial.reconcile", "block");
  await assert.rejects(
    finalizer.finalize({ scopeId: blocked.scopeId, jobId: blocked.id, idempotencyKey: randomUUID() }),
    /block.*financial\.reconcile/i,
  );
});

test("finalizer rejects scope mismatch and a rejected artifact-free job", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const rejected = await createApprovedJob(store, "reject");
  const finalizer = createSignedFinnyFinalizer(store, SECRET);
  await assert.rejects(
    finalizer.finalize({ scopeId: "personal:U2", jobId: rejected.id, idempotencyKey: randomUUID() }),
    /not found.*scope/i,
  );
  await assert.rejects(
    finalizer.finalize({ scopeId: rejected.scopeId, jobId: rejected.id, idempotencyKey: randomUUID() }),
    /artifact/i,
  );
});

test("signing failure rolls back approval consumption and finalization", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const job = await createApprovedJob(store);
  await passChecks(store, job);
  const broken = createFinnyFinalizer(store, async () => {
    throw new Error("signer unavailable");
  });
  await assert.rejects(
    broken.finalize({ scopeId: job.scopeId, jobId: job.id, idempotencyKey: randomUUID() }),
    /signer unavailable/i,
  );
  const afterFailure = await store.getJob(job.scopeId, job.id);
  assert.equal(afterFailure?.approval?.consumedAt, undefined);
  assert.equal(afterFailure?.finalReceipt, undefined);

  const receipt = await createSignedFinnyFinalizer(store, SECRET).finalize({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: randomUUID(),
  });
  assert.equal(receipt.payload.jobId, job.id);
  await assert.rejects(attest(store, job, "lineage.binding", "block"), /finalized/i);
});

test("finalization serializes a concurrent BLOCK behind the job lock", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const job = await createApprovedJob(store);
  await passChecks(store, job);
  let releaseSigner: (() => void) | undefined;
  let signerEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    signerEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseSigner = resolve;
  });
  const finalizer = createFinnyFinalizer(store, async (payload) => {
    signerEntered?.();
    await release;
    return mintSignedPayload(payload, SECRET);
  });
  const finalizing = finalizer.finalize({ scopeId: job.scopeId, jobId: job.id, idempotencyKey: randomUUID() });
  await entered;
  const blocking = attest(store, job, "financial.reconcile", "block");
  releaseSigner?.();
  const receipt = await finalizing;
  assert.equal(receipt.payload.jobId, job.id);
  await assert.rejects(blocking, /finalized/i);
});

test("concurrent finalizers with the same key converge on one receipt", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const job = await createApprovedJob(store);
  await passChecks(store, job);
  const finalizer = createSignedFinnyFinalizer(store, SECRET);
  const idempotencyKey = randomUUID();
  const [first, second] = await Promise.all([
    finalizer.finalize({ scopeId: job.scopeId, jobId: job.id, idempotencyKey }),
    finalizer.finalize({ scopeId: job.scopeId, jobId: job.id, idempotencyKey }),
  ]);
  assert.deepEqual(second, first);
});

test("finalizer rejects current-generation PASS attestations bound to another artifact", async () => {
  const connectionString = testDatabaseUrl();
  const store = createPostgresFinnyStore(connectionString);
  const job = await createApprovedJob(store);
  await passChecks(store, job);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("UPDATE finny_jobs SET artifact_digest=$2, provisional_revision=$3 WHERE id=$1", [
    job.id,
    "replacement-artifact",
    "replacement-revision",
  ]);
  await client.end();
  await assert.rejects(
    createSignedFinnyFinalizer(store, SECRET).finalize({
      scopeId: job.scopeId,
      jobId: job.id,
      idempotencyKey: randomUUID(),
    }),
    /stale artifact evidence/i,
  );
});
