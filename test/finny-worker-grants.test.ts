import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { verifySignedPayload } from "../src/auth/signed-token.ts";
import { FINNY_CHECK_IDS, initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createFinnyWorkerGrants } from "../src/finny/worker-grants.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "finny-worker-grant-test-secret";

async function approvedJob() {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = {
    id: randomUUID(),
    scopeId: "personal:U1",
    plan: {
      title: "Finance pack",
      phases: [{ name: "Produce", owner: "MIS Expert", dependencies: [] }],
      certification: "Independent checks",
      deliverable: "Workbook",
      destination: "Origin thread",
      clarifications: [],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    originThreadRef: `slack:C1:${randomUUID()}`,
    findingPolicy: { id: "finny-r5-test", maxFindings: 8, maxCodeLength: 80, maxMessageLength: 2_000 },
  };
  const job = await store.createJob(input);
  const requestId = randomUUID();
  await store.createApprovalRequest({ scopeId: job.scopeId, jobId: job.id, requestId, authorizedActorId: "U1" });
  await store.recordApproval({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: job.originThreadRef,
    decidedAt: Date.now(),
  });
  return { store, job };
}

test("issues a producer grant before an artifact exists", async () => {
  const { store, job } = await approvedJob();
  const now = Date.now();
  const grants = createFinnyWorkerGrants(store, SECRET, () => now);
  const producer = await grants.issueProducer({
    scopeId: job.scopeId,
    jobId: job.id,
    principalId: "U1",
    runId: "run-producer",
    expiresAt: now + 60_000,
  });
  assert.equal(producer.payload.role, "producer");
  assert.equal(producer.payload.runId, "run-producer");
  assert.equal(producer.payload.artifactDigest, undefined);
  assert.deepEqual(producer.payload.allowedChecks, []);
  assert.deepEqual(await verifySignedPayload(producer.token, SECRET), producer.payload);
});

test("refuses an Auditor evidence grant before artifact_ready", async () => {
  const { store, job } = await approvedJob();
  const now = Date.now();
  const grants = createFinnyWorkerGrants(store, SECRET, () => now);
  await assert.rejects(
    grants.issueAuditor({
      scopeId: job.scopeId,
      jobId: job.id,
      principalId: "U1",
      runId: "run-auditor",
      expiresAt: now + 60_000,
    }),
    /artifact/i,
  );
});

test("issues an artifact-bound Auditor grant after artifact_ready", async () => {
  const { store, job } = await approvedJob();
  await store.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: randomUUID(),
  });
  const now = Date.now();
  const grants = createFinnyWorkerGrants(store, SECRET, () => now);
  const auditor = await grants.issueAuditor({
    scopeId: job.scopeId,
    jobId: job.id,
    principalId: "U1",
    runId: "run-auditor",
    expiresAt: now + 60_000,
  });
  assert.equal(auditor.payload.role, "auditor");
  assert.equal(auditor.payload.artifactDigest, "artifact-sha256");
  assert.deepEqual(auditor.payload.allowedChecks, FINNY_CHECK_IDS);
  const accepted = await grants.submitAttestation(auditor.token, {
    id: randomUUID(),
    checkId: "lineage.binding",
    generation: 1,
    verdict: "pass",
    evidenceDigest: `evidence-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  });
  assert.equal(accepted.attestation.artifactDigest, "artifact-sha256");
  assert.equal(accepted.attestation.issuerRunId, "run-auditor");
});

test("producer and Auditor run identities must remain distinct", async () => {
  const { store, job } = await approvedJob();
  const now = Date.now();
  const grants = createFinnyWorkerGrants(store, SECRET, () => now);
  await grants.issueProducer({
    scopeId: job.scopeId,
    jobId: job.id,
    principalId: "U1",
    runId: "same-run",
    expiresAt: now + 60_000,
  });
  await store.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: randomUUID(),
  });
  await assert.rejects(
    grants.issueAuditor({
      scopeId: job.scopeId,
      jobId: job.id,
      principalId: "U1",
      runId: "same-run",
      expiresAt: now + 60_000,
    }),
    /distinct/i,
  );
});
