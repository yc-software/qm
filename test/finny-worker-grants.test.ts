import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { verifySignedPayload } from "../src/auth/signed-token.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createFinnyWorkerGrants } from "../src/finny/worker-grants.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "finny-worker-grant-test-secret";

async function approvedJob() {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const job = {
    id: randomUUID(),
    scopeId: "personal:U1",
    planDigest: `plan-${randomUUID()}`,
    artifactDigest: `artifact-${randomUUID()}`,
    policy: initialFinnyPolicy(),
    originThreadRef: `slack:C1:${randomUUID()}`,
    findingPolicy: {
      id: "finny-r5-test",
      maxFindings: 8,
      maxCodeLength: 80,
      maxMessageLength: 2_000,
    },
    provisionalRevision: `revision-${randomUUID()}`,
  };
  await store.createJob(job);
  await store.recordApproval({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId: randomUUID(),
    actorId: "U1",
    action: "approve",
    planDigest: job.planDigest,
    originThreadRef: job.originThreadRef,
    decidedAt: Date.now(),
  });
  return { store, job };
}

test("Core issues a producer and an Auditor grant bound to exact runs and policy", async () => {
  const { store, job } = await approvedJob();
  const now = Date.now();
  const grants = createFinnyWorkerGrants(store, SECRET, () => now);
  const pair = await grants.issuePair({
    scopeId: job.scopeId,
    jobId: job.id,
    principalId: "U1",
    producerRunId: "run-producer",
    auditorRunId: "run-auditor",
    expiresAt: now + 60_000,
  });
  assert.equal(pair.producer.payload.role, "producer");
  assert.equal(pair.producer.payload.runId, "run-producer");
  assert.deepEqual(pair.producer.payload.allowedChecks, []);
  assert.equal(pair.auditor.payload.role, "auditor");
  assert.equal(pair.auditor.payload.runId, "run-auditor");
  assert.deepEqual(pair.auditor.payload.allowedChecks, Object.keys(job.policy.requiredGenerations));
  assert.deepEqual(await verifySignedPayload(pair.auditor.token, SECRET), pair.auditor.payload);
});

test("only the exact Auditor grant can submit evidence", async () => {
  const { store, job } = await approvedJob();
  const now = Date.now();
  const grants = createFinnyWorkerGrants(store, SECRET, () => now);
  const pair = await grants.issuePair({
    scopeId: job.scopeId,
    jobId: job.id,
    principalId: "U1",
    producerRunId: "run-producer",
    auditorRunId: "run-auditor",
    expiresAt: now + 60_000,
  });
  const submission = {
    id: randomUUID(),
    checkId: "lineage.binding" as const,
    generation: 1,
    verdict: "pass" as const,
    evidenceDigest: `evidence-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(grants.submitAttestation(pair.producer.token, submission), /auditor/i);
  const accepted = await grants.submitAttestation(pair.auditor.token, submission);
  assert.equal(accepted.attestation.jobId, job.id);
  assert.equal(accepted.attestation.artifactDigest, job.artifactDigest);
  assert.equal(accepted.attestation.issuerRunId, "run-auditor");
  assert.equal(accepted.attestation.issuerPrincipalId, "U1");

  const expired = createFinnyWorkerGrants(store, SECRET, () => now + 60_001);
  await assert.rejects(expired.submitAttestation(pair.auditor.token, { ...submission, id: randomUUID() }), /expired/i);
  const wrongSecret = createFinnyWorkerGrants(store, "wrong-secret", () => now);
  await assert.rejects(
    wrongSecret.submitAttestation(pair.auditor.token, { ...submission, id: randomUUID() }),
    /grant/i,
  );
});

test("worker grants cannot cross job, scope, artifact, run, or policy boundaries", async () => {
  const first = await approvedJob();
  const second = await approvedJob();
  const now = Date.now();
  const grants = createFinnyWorkerGrants(first.store, SECRET, () => now);
  const pair = await grants.issuePair({
    scopeId: first.job.scopeId,
    jobId: first.job.id,
    principalId: "U1",
    producerRunId: "run-producer",
    auditorRunId: "run-auditor",
    expiresAt: now + 60_000,
  });
  await first.store.createJob({ ...second.job, id: randomUUID(), scopeId: "personal:U2" });
  const payload = { ...pair.auditor.payload, jobId: second.job.id };
  const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.forged`;
  await assert.rejects(
    grants.submitAttestation(forged, {
      id: randomUUID(),
      checkId: "lineage.binding",
      generation: 1,
      verdict: "pass",
      evidenceDigest: "evidence",
      idempotencyKey: randomUUID(),
    }),
    /grant/i,
  );
});
