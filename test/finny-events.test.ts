import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { FINNY_CHECK_IDS, type FinnyJobEvent } from "../src/finny/types.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const findingPolicy = {
  id: "finny-r5-test",
  maxFindings: 8,
  maxCodeLength: 80,
  maxMessageLength: 2_000,
};

const createInput = () => ({
  id: randomUUID(),
  scopeId: "personal:U1",
  planDigest: "plan-sha256",
  artifactDigest: "artifact-sha256-v1",
  policy: initialFinnyPolicy(),
  originThreadRef: "slack:C1:100.1",
  provisionalRevision: "delivery-revision-1",
  findingPolicy,
});

test("BLOCK requests rework and advances only invalidated check generations", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  const original = await store.createJob(input);

  const result = await store.recordAuditBlock({
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "formula.recalculate",
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "FORMULA_DRIFT", message: "Cell G12 differs from the source schedule" }],
    changeKinds: ["formula"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });

  assert.equal(result.deduped, false);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["audit_blocked", "rework_requested"],
  );
  const blocked = result.events.find(
    (event): event is FinnyJobEvent<"audit_blocked"> => event.type === "audit_blocked",
  );
  assert.equal(blocked?.payload.findings[0]?.code, "FORMULA_DRIFT");
  assert.equal(result.job.policy.requiredGenerations["formula.recalculate"], 2);
  assert.equal(result.job.policy.requiredGenerations["financial.reconcile"], 1);
  assert.equal(result.job.policy.requiredGenerations["artifact.integrity"], 2);
  assert.equal(result.job.policy.requiredGenerations["lineage.binding"], 2);
  assert.equal(result.job.policy.requiredGenerations["source.completeness"], 1);
  assert.equal(result.job.policy.requiredGenerations["summary.crossfoot"], 2);
  assert.equal(result.job.policy.requiredGenerations["meaning.actionability"], 2);
  assert.equal(result.job.policy.requiredGenerations["artifact.structure"], 1);
  assert.equal(result.job.eventHead, result.events[1]?.seq);
  assert.deepEqual(original.policy.requiredGenerations, initialFinnyPolicy().requiredGenerations);
});

test("duplicate BLOCK submissions return the original transition without advancing policy again", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const firstSubmission = {
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding" as const,
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "LINEAGE", message: "Missing source binding" }],
    changeKinds: ["lineage" as const],
    resolution: { kind: "rework" as const },
    idempotencyKey: randomUUID(),
  };
  const first = await store.recordAuditBlock(firstSubmission);
  await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "artifact-sha256-v2",
    provisionalRevision: "delivery-revision-2",
    idempotencyKey: randomUUID(),
  });
  await store.recordAuditBlock({
    ...firstSubmission,
    generation: 2,
    artifactDigest: "artifact-sha256-v2",
    findings: [{ code: "LINEAGE_2", message: "Source binding remains incomplete" }],
    idempotencyKey: randomUUID(),
  });

  const duplicate = await store.recordAuditBlock(firstSubmission);

  assert.equal(duplicate.deduped, true);
  assert.deepEqual(duplicate.events, first.events);
  assert.equal(duplicate.job.policy.requiredGenerations["lineage.binding"], 3);
  assert.equal((await store.getJob(input.scopeId, input.id))?.policy.requiredGenerations["lineage.binding"], 3);
});

test("stale and wrong-scope audit events fail without changing authoritative state", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const submission = {
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding" as const,
    generation: 2,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "LINEAGE", message: "Missing source binding" }],
    changeKinds: ["lineage" as const],
    resolution: { kind: "rework" as const },
    idempotencyKey: randomUUID(),
  };

  await assert.rejects(store.recordAuditBlock(submission), /generation is not current/i);
  await assert.rejects(
    store.recordAuditBlock({ ...submission, scopeId: "personal:U2", generation: 1 }),
    /not found in this scope/i,
  );
  assert.deepEqual(await store.listEvents(input.scopeId, input.id), []);
  assert.equal((await store.getJob(input.scopeId, input.id))?.eventHead, 0);
});

test("artifact and audit events expose the latest server sequence", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const artifact = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: input.artifactDigest,
    provisionalRevision: input.provisionalRevision,
    idempotencyKey: randomUUID(),
  });
  const passed = await store.recordAuditPassed({
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 1,
    artifactDigest: input.artifactDigest,
    evidenceDigest: "evidence-sha256-v2",
    idempotencyKey: randomUUID(),
  });

  assert.equal(artifact.events[0]?.type, "artifact_ready");
  assert.equal(passed.events[0]?.type, "audit_passed");
  assert.ok((passed.events[0]?.seq ?? 0) > (artifact.events[0]?.seq ?? 0));
  const latest = await store.listEvents(input.scopeId, input.id, artifact.events[0]?.seq);
  assert.deepEqual(latest, passed.events);
  assert.equal(passed.job.eventHead, passed.events[0]?.seq);
  assert.equal((await store.getJob(input.scopeId, input.id))?.eventHead, passed.events[0]?.seq);
});

test("external escalation decisions are recorded without an internal retry cap", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const result = await store.recordAuditBlock({
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "meaning.actionability",
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "AMBIGUOUS", message: "The recommendation lacks an owner" }],
    changeKinds: ["disclosure"],
    resolution: { kind: "escalate", reason: "External policy requires controller review" },
    idempotencyKey: randomUUID(),
  });

  assert.deepEqual(
    result.events.map((event) => event.type),
    ["audit_blocked", "escalated"],
  );
  const escalated = result.events.find((event): event is FinnyJobEvent<"escalated"> => event.type === "escalated");
  assert.equal(escalated?.payload.reason, "External policy requires controller review");
  assert.deepEqual(result.job.policy, initialFinnyPolicy());
});

test("BLOCK rejects findings beyond the bounded event contract", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = { ...createInput(), findingPolicy: { ...findingPolicy, maxFindings: 20 } };
  await store.createJob(input);

  await assert.rejects(
    store.recordAuditBlock({
      scopeId: input.scopeId,
      jobId: input.id,
      checkId: "lineage.binding",
      generation: 1,
      artifactDigest: input.artifactDigest,
      findings: Array.from({ length: 21 }, (_, index) => ({ code: `F${index}`, message: "Finding" })),
      changeKinds: ["lineage"],
      resolution: { kind: "rework" },
      idempotencyKey: randomUUID(),
    }),
    /findings count is invalid/i,
  );
  assert.deepEqual(await store.listEvents(input.scopeId, input.id), []);
});

test("an idempotency key cannot replay events from another job or scope", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const first = createInput();
  const second = { ...createInput(), scopeId: "personal:U2" };
  await store.createJob(first);
  await store.createJob(second);
  const idempotencyKey = randomUUID();
  await store.recordArtifactReady({
    scopeId: first.scopeId,
    jobId: first.id,
    artifactDigest: first.artifactDigest,
    provisionalRevision: first.provisionalRevision,
    idempotencyKey,
  });

  await assert.rejects(
    store.recordArtifactReady({
      scopeId: second.scopeId,
      jobId: second.id,
      artifactDigest: first.artifactDigest,
      provisionalRevision: first.provisionalRevision,
      idempotencyKey,
    }),
    /idempotency key was reused/i,
  );
  assert.deepEqual(await store.listEvents(second.scopeId, second.id), []);
});

test("runtime event validation rejects unknown checks and malformed generations", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const base = {
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "unknown.check" as never,
    generation: undefined as never,
    artifactDigest: input.artifactDigest,
    evidenceDigest: "evidence-sha256",
    idempotencyKey: randomUUID(),
  };

  await assert.rejects(store.recordAuditPassed(base), /required check|generation is invalid/i);
  await assert.rejects(store.recordAuditPassed({ ...base, checkId: "lineage.binding", generation: 0 }), /generation/i);
  assert.deepEqual(await store.listEvents(input.scopeId, input.id), []);
});

test("finalized jobs reject new event transitions", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId: randomUUID(),
    actorId: "U1",
    action: "approve",
    planDigest: input.planDigest,
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  for (const checkId of FINNY_CHECK_IDS) {
    await store.recordAttestation({
      id: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.id,
      checkId,
      generation: 1,
      verdict: "pass",
      evidenceDigest: `evidence-${checkId}`,
      artifactDigest: input.artifactDigest,
      issuerPrincipalId: "U-auditor",
      issuerRunId: "run-auditor-1",
      idempotencyKey: randomUUID(),
    });
  }
  await store.finalize(
    { scopeId: input.scopeId, jobId: input.id, idempotencyKey: randomUUID() },
    async () => "signed-receipt",
  );

  await assert.rejects(
    store.recordArtifactReady({
      scopeId: input.scopeId,
      jobId: input.id,
      artifactDigest: "artifact-after-finalization",
      provisionalRevision: "revision-after-finalization",
      idempotencyKey: randomUUID(),
    }),
    /already finalized/i,
  );
  await assert.rejects(
    store.recordAuditPassed({
      scopeId: input.scopeId,
      jobId: input.id,
      checkId: "lineage.binding",
      generation: 1,
      artifactDigest: input.artifactDigest,
      evidenceDigest: "evidence-after-finalization",
      idempotencyKey: randomUUID(),
    }),
    /already finalized/i,
  );
  await assert.rejects(
    store.recordAuditBlock({
      scopeId: input.scopeId,
      jobId: input.id,
      checkId: "lineage.binding",
      generation: 1,
      artifactDigest: input.artifactDigest,
      findings: [{ code: "LATE", message: "Late finding" }],
      changeKinds: ["lineage"],
      resolution: { kind: "rework" },
      idempotencyKey: randomUUID(),
    }),
    /already finalized/i,
  );
});

test("the external finding policy supplies the BLOCK finding bound", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = {
    ...createInput(),
    findingPolicy: { ...findingPolicy, id: "controller-review-v1", maxFindings: 1 },
  };
  await store.createJob(input);
  const submission = {
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding" as const,
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [
      { code: "ONE", message: "First finding" },
      { code: "TWO", message: "Second finding" },
    ],
    findingPolicy: { ...findingPolicy, id: "caller-raised", maxFindings: 100 },
    changeKinds: ["lineage" as const],
    resolution: { kind: "rework" as const },
    idempotencyKey: randomUUID(),
  };

  await assert.rejects(store.recordAuditBlock(submission), /findings count is invalid/i);
  assert.deepEqual(await store.listEvents(input.scopeId, input.id), []);
});

test("artifact replacement requires an authoritative rework request", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);

  await assert.rejects(
    store.recordArtifactReady({
      scopeId: input.scopeId,
      jobId: input.id,
      artifactDigest: "artifact-sha256-v2",
      provisionalRevision: "delivery-revision-2",
      idempotencyKey: randomUUID(),
    }),
    /rework request/i,
  );
  assert.equal((await store.getJob(input.scopeId, input.id))?.artifactDigest, input.artifactDigest);

  await store.recordAuditBlock({
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "LINEAGE", message: "Missing source binding" }],
    changeKinds: ["lineage"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });
  const ready = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "artifact-sha256-v2",
    provisionalRevision: "delivery-revision-2",
    idempotencyKey: randomUUID(),
  });
  assert.equal(ready.job.artifactDigest, "artifact-sha256-v2");
  await assert.rejects(
    store.recordAttestation({
      id: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.id,
      checkId: "lineage.binding",
      generation: 2,
      verdict: "pass",
      evidenceDigest: "lineage-evidence-old-artifact",
      artifactDigest: input.artifactDigest,
      issuerPrincipalId: "U-auditor",
      issuerRunId: "run-auditor-2",
      idempotencyKey: randomUUID(),
    }),
    /artifact is not current/i,
  );
  const passed = await store.recordAuditPassed({
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 2,
    artifactDigest: "artifact-sha256-v2",
    evidenceDigest: "lineage-evidence-v2",
    idempotencyKey: randomUUID(),
  });
  assert.equal(passed.events[0]?.payload.generation, 2);
});

test("re-audit waits for a new artifact to consume the rework request", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  await store.recordAuditBlock({
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "LINEAGE", message: "Missing source binding" }],
    changeKinds: ["lineage"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });

  await assert.rejects(
    store.recordAuditPassed({
      scopeId: input.scopeId,
      jobId: input.id,
      checkId: "lineage.binding",
      generation: 2,
      artifactDigest: input.artifactDigest,
      evidenceDigest: "evidence-without-rework",
      idempotencyKey: randomUUID(),
    }),
    /awaiting a reworked artifact/i,
  );
  await assert.rejects(
    store.recordAttestation({
      id: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.id,
      checkId: "lineage.binding",
      generation: 2,
      verdict: "pass",
      evidenceDigest: "evidence-without-rework",
      artifactDigest: input.artifactDigest,
      issuerPrincipalId: "U-auditor",
      issuerRunId: "run-auditor-2",
      idempotencyKey: randomUUID(),
    }),
    /awaiting a reworked artifact/i,
  );
});

test("unresolved escalation blocks final delivery", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId: randomUUID(),
    actorId: "U1",
    action: "approve",
    planDigest: input.planDigest,
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  for (const checkId of FINNY_CHECK_IDS) {
    await store.recordAttestation({
      id: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.id,
      checkId,
      generation: 1,
      verdict: "pass",
      evidenceDigest: `evidence-${checkId}`,
      artifactDigest: input.artifactDigest,
      issuerPrincipalId: "U-auditor",
      issuerRunId: "run-auditor-1",
      idempotencyKey: randomUUID(),
    });
  }
  await store.recordAuditBlock({
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "meaning.actionability",
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "AMBIGUOUS", message: "Controller judgment required" }],
    changeKinds: ["disclosure"],
    resolution: { kind: "escalate", reason: "External policy requires controller review" },
    idempotencyKey: randomUUID(),
  });

  await assert.rejects(
    store.finalize(
      { scopeId: input.scopeId, jobId: input.id, idempotencyKey: randomUUID() },
      async () => "must-not-sign",
    ),
    /unresolved escalation/i,
  );
});

test("authoritative finding policy rejects oversized finding text", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = { ...createInput(), findingPolicy: { ...findingPolicy, maxMessageLength: 10 } };
  await store.createJob(input);

  await assert.rejects(
    store.recordAuditBlock({
      scopeId: input.scopeId,
      jobId: input.id,
      checkId: "lineage.binding",
      generation: 1,
      artifactDigest: input.artifactDigest,
      findings: [{ code: "LINEAGE", message: "This message is too long" }],
      changeKinds: ["lineage"],
      resolution: { kind: "rework" },
      idempotencyKey: randomUUID(),
    }),
    /finding text exceeds policy/i,
  );
});
