import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { canonicalFinnyPlanDigest } from "../src/finny/plan.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const plan = () => ({
  title: "Monthly finance pack",
  phases: [
    { name: "Prepare", owner: "MIS Expert", dependencies: [] },
    { name: "Certify", owner: "Auditor", dependencies: ["Prepare"] },
  ],
  certification: "All required checks pass",
  deliverable: "Certified workbook",
  destination: "Origin thread",
  clarifications: [{ question: "Entity?", answer: "Consolidated group" }],
});

const createInput = () => ({
  id: randomUUID(),
  scopeId: "personal:U1",
  plan: plan(),
  policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
  findingPolicy: {
    id: "finny-r5-test",
    maxFindings: 8,
    maxCodeLength: 80,
    maxMessageLength: 2_000,
  },
  originThreadRef: "slack:C1:100.1",
});

async function approve(store: ReturnType<typeof createPostgresFinnyStore>, input: ReturnType<typeof createInput>) {
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    authorizedActorId: "U1",
  });
  return store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
}

test("creates a job from a validated presentation with no artifact", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  const created = await store.createJob(input);
  assert.equal(created.planDigest, canonicalFinnyPlanDigest(input.plan));
  assert.deepEqual(created.plan, input.plan);
  assert.equal(created.artifactDigest, undefined);
  assert.equal(created.provisionalRevision, undefined);
  assert.equal(created.approval, undefined);
  assert.deepEqual(await store.getJob(input.scopeId, input.id), created);
});

test("approval decision derives exact bindings from an opaque pre-bound request", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    authorizedActorId: "U1",
  });
  const approved = await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  assert.equal(approved.approval?.planDigest, approved.planDigest);
  assert.equal(approved.approval?.originThreadRef, input.originThreadRef);
  await assert.rejects(
    store.recordApproval({
      scopeId: input.scopeId,
      jobId: input.id,
      requestId,
      actorId: "U2",
      action: "reject",
      originThreadRef: input.originThreadRef,
      decidedAt: Date.now(),
    }),
    /actor|decided/i,
  );

  const other = createInput();
  await store.createJob(other);
  await assert.rejects(
    store.recordApproval({
      scopeId: other.scopeId,
      jobId: other.id,
      requestId,
      actorId: "U1",
      action: "approve",
      originThreadRef: other.originThreadRef,
      decidedAt: Date.now(),
    }),
    /binding|request/i,
  );
});

test("artifact_ready sets the first artifact only after approval", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const readiness = {
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "delivery-revision-1",
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(store.recordArtifactReady(readiness), /approved/i);
  await approve(store, input);
  const ready = await store.recordArtifactReady(readiness);
  assert.equal(ready.job.artifactDigest, readiness.artifactDigest);
  assert.equal(ready.job.provisionalRevision, readiness.provisionalRevision);
  await assert.rejects(
    store.recordArtifactReady({ ...readiness, artifactDigest: "replacement", idempotencyKey: randomUUID() }),
    /rework/i,
  );
});

test("attestations require a current artifact", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  await approve(store, input);
  const submission = {
    id: randomUUID(),
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding" as const,
    generation: 1,
    verdict: "pass" as const,
    evidenceDigest: "evidence-sha256",
    artifactDigest: "artifact-sha256",
    issuerPrincipalId: "U-auditor",
    issuerRunId: "run-auditor-1",
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(store.recordAttestation(submission), /artifact/i);
  await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: submission.artifactDigest,
    provisionalRevision: "delivery-revision-1",
    idempotencyKey: randomUUID(),
  });
  const first = await store.recordAttestation(submission);
  const duplicate = await store.recordAttestation(submission);
  assert.equal(first.deduped, false);
  assert.equal(duplicate.deduped, true);
  assert.deepEqual(duplicate.attestation, first.attestation);
});
