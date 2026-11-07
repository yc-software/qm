import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { FINNY_CHECK_IDS, initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import type { FinnyEvaluatorRef, FinnyJob } from "../src/finny/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const EVALUATOR_V1: FinnyEvaluatorRef = {
  id: "spreadsheet-core",
  revision: "1",
  buildDigest: "sha256:build-v1",
  contractVersion: "finny-deterministic-v1",
  configurationDigest: "sha256:config-v1",
};
const EVALUATOR_V2: FinnyEvaluatorRef = { ...EVALUATOR_V1, revision: "2", buildDigest: "sha256:build-v2" };
const DETERMINISTIC = ["formula.recalculate", "summary.crossfoot", "artifact.structure"] as const;

async function createJob(options: { artifact?: boolean } = { artifact: true }) {
  const store = createPostgresFinnyStore(testDatabaseUrl());
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
    policy: initialFinnyPolicy(EVALUATOR_V1),
    findingPolicy: { id: "test", maxFindings: 8, maxCodeLength: 80, maxMessageLength: 2_000 },
    originThreadRef: `slack:C1:${randomUUID()}`,
  };
  await store.createJob(input);
  const requestId = randomUUID();
  await store.createApprovalRequest({ scopeId: input.scopeId, jobId: input.id, requestId, authorizedActorId: "U1" });
  await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  if (options.artifact !== false) {
    await store.recordArtifactReady({
      scopeId: input.scopeId,
      jobId: input.id,
      artifactDigest: "sha256:immutable-artifact",
      provisionalRevision: "file:immutable-revision",
      idempotencyKey: randomUUID(),
    });
  }
  return { store, input, job: (await store.getJob(input.scopeId, input.id))! };
}

async function pass(
  store: ReturnType<typeof createPostgresFinnyStore>,
  job: FinnyJob,
  checkId: (typeof FINNY_CHECK_IDS)[number],
) {
  return store.recordAttestation({
    id: randomUUID(),
    scopeId: job.scopeId,
    jobId: job.id,
    checkId,
    generation: job.policy.requiredGenerations[checkId],
    verdict: "pass",
    evidenceDigest: `evidence:${checkId}:${randomUUID()}`,
    artifactDigest: job.artifactDigest!,
    issuerPrincipalId: "auditor",
    issuerRunId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
}

async function deterministicBlock(store: ReturnType<typeof createPostgresFinnyStore>, job: FinnyJob) {
  return store.recordAuditBlock({
    scopeId: job.scopeId,
    jobId: job.id,
    checkId: "formula.recalculate",
    generation: job.policy.requiredGenerations["formula.recalculate"],
    artifactDigest: job.artifactDigest!,
    evidenceDigest: "evidence:block",
    issuerPrincipalId: "auditor",
    issuerRunId: randomUUID(),
    findings: [{ code: "FORMULA", message: "old evaluator reported a formula defect" }],
    changeKinds: ["formula"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });
}

function correction(job: FinnyJob, idempotencyKey = randomUUID()) {
  return {
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: EVALUATOR_V1,
    toEvaluator: EVALUATOR_V2,
    idempotencyKey,
  };
}

test("evaluator correction preserves immutable artifact and history while advancing only deterministic checks", async () => {
  const { store, job } = await createJob();
  await pass(store, job, "source.completeness");
  const blocked = await deterministicBlock(store, job);
  const before = blocked.job;
  const oldEvents = await store.listEvents(job.scopeId, job.id);
  const key = randomUUID();

  const corrected = await store.recordEvaluatorCorrection(correction(before, key));
  assert.equal(corrected.deduped, false);
  assert.equal(corrected.job.artifactDigest, before.artifactDigest);
  assert.equal(corrected.job.provisionalRevision, before.provisionalRevision);
  assert.deepEqual(corrected.job.policy.evaluator, EVALUATOR_V2);
  assert.equal(corrected.job.pendingReworkSequence, undefined);
  assert.deepEqual(
    corrected.events.map((event) => event.type),
    ["evaluator_revision_activated", "evidence_invalidated", "rework_cancelled", "verification_reopened"],
  );
  assert.deepEqual(corrected.events[0]!.payload, { fromEvaluator: EVALUATOR_V1, toEvaluator: EVALUATOR_V2 });
  assert.deepEqual(corrected.events.at(-1)!.payload, {
    evaluator: EVALUATOR_V2,
    previousRequiredGenerations: before.policy.requiredGenerations,
    requiredGenerations: corrected.job.policy.requiredGenerations,
  });
  for (const checkId of FINNY_CHECK_IDS) {
    const delta = corrected.job.policy.requiredGenerations[checkId] - before.policy.requiredGenerations[checkId];
    assert.equal(delta, DETERMINISTIC.includes(checkId as (typeof DETERMINISTIC)[number]) ? 1 : 0, checkId);
  }
  const events = await store.listEvents(job.scopeId, job.id);
  assert.deepEqual(events.slice(0, oldEvents.length), oldEvents);
  assert.ok(events.some((event) => event.type === "audit_blocked"));

  const replay = await store.recordEvaluatorCorrection(correction(before, key));
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.events, corrected.events);
  assert.deepEqual(replay.job, corrected.job);
});

test("evaluator correction rejects stale authority, missing artifact, escalation, and non-deterministic rework", async () => {
  const missing = await createJob({ artifact: false });
  await assert.rejects(missing.store.recordEvaluatorCorrection(correction(missing.job)), /artifact/i);

  const stale = await createJob();
  await assert.rejects(
    stale.store.recordEvaluatorCorrection({
      ...correction(stale.job),
      fromEvaluator: { ...EVALUATOR_V1, revision: "stale" },
    }),
    /current evaluator|stale/i,
  );

  const nondeterministic = await createJob();
  const block = await nondeterministic.store.recordAuditBlock({
    scopeId: nondeterministic.job.scopeId,
    jobId: nondeterministic.job.id,
    checkId: "meaning.actionability",
    generation: 1,
    artifactDigest: nondeterministic.job.artifactDigest!,
    evidenceDigest: "evidence:block-human",
    issuerPrincipalId: "auditor",
    issuerRunId: randomUUID(),
    findings: [{ code: "MEANING", message: "not actionable" }],
    changeKinds: ["disclosure"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });
  await assert.rejects(
    nondeterministic.store.recordEvaluatorCorrection(correction(block.job)),
    /non-deterministic|unrelated/i,
  );

  const escalated = await createJob();
  await escalated.store.recordAuditBlock({
    scopeId: escalated.job.scopeId,
    jobId: escalated.job.id,
    checkId: "formula.recalculate",
    generation: 1,
    artifactDigest: escalated.job.artifactDigest!,
    evidenceDigest: "evidence:escalated",
    issuerPrincipalId: "auditor",
    issuerRunId: randomUUID(),
    findings: [{ code: "FORMULA", message: "defect" }],
    changeKinds: ["formula"],
    resolution: { kind: "escalate", reason: "bounded retry exhausted" },
    idempotencyKey: randomUUID(),
  });
  await assert.rejects(escalated.store.recordEvaluatorCorrection(correction(escalated.job)), /escalation/i);
});

test("a current PASS can finalize under the corrected evaluator while the old BLOCK remains", async () => {
  const { store, job } = await createJob();
  const blocked = await deterministicBlock(store, job);
  const corrected = await store.recordEvaluatorCorrection(correction(blocked.job));
  for (const checkId of FINNY_CHECK_IDS) await pass(store, corrected.job, checkId);
  const receipt = await store.finalize(
    { scopeId: job.scopeId, jobId: job.id, idempotencyKey: randomUUID() },
    async () => "signed",
  );
  assert.deepEqual(receipt.payload.evaluator, EVALUATOR_V2);
  const events = await store.listEvents(job.scopeId, job.id);
  assert.ok(events.some((event) => event.type === "audit_blocked"));
  await assert.rejects(store.recordEvaluatorCorrection(correction(corrected.job)), /finalized/i);
});
