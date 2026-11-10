import { TEST_FINNY_EVALUATOR, testDeterministicAuthority } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { FINNY_CHECK_IDS, type FinnyJobEvent } from "../src/finny/types.ts";
import { createPostgresFinnyStore as createRawPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

function createPostgresFinnyStore(connectionString: string) {
  const store = createRawPostgresFinnyStore(connectionString);
  return {
    ...store,
    recordAttestation(input: Parameters<typeof store.recordAttestation>[0]) {
      return store.recordAttestation({
        ...input,
        ...testDeterministicAuthority(input.checkId, input.verdict, TEST_FINNY_EVALUATOR),
      });
    },
    recordAuditPassed(input: Parameters<typeof store.recordAuditPassed>[0]) {
      return store.recordAuditPassed({
        ...input,
        ...testDeterministicAuthority(input.checkId, "pass", TEST_FINNY_EVALUATOR),
      });
    },
    recordAuditBlock(input: Parameters<typeof store.recordAuditBlock>[0]) {
      return store.recordAuditBlock({
        ...input,
        ...testDeterministicAuthority(input.checkId, "block", TEST_FINNY_EVALUATOR),
      });
    },
  };
}

const findingPolicy = {
  id: "finny-r5-test",
  maxFindings: 8,
  maxCodeLength: 80,
  maxMessageLength: 2_000,
};

const auditAuthority = {
  evidenceDigest: "evidence-sha256",
  issuerPrincipalId: "auditor-principal",
  issuerRunId: "auditor-run",
};

const createInput = () => ({
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
  artifactDigest: "artifact-sha256-v1",
  policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
  originThreadRef: "slack:C1:100.1",
  provisionalRevision: "delivery-revision-1",
  findingPolicy,
});

async function approveJob(store: ReturnType<typeof createPostgresFinnyStore>, input: ReturnType<typeof createInput>) {
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

async function createApprovedPlan(
  store: ReturnType<typeof createPostgresFinnyStore>,
  input: ReturnType<typeof createInput>,
) {
  const created = await store.createJob(input);
  await approveJob(store, input);
  return created;
}

async function createReadyJob(
  store: ReturnType<typeof createPostgresFinnyStore>,
  input: ReturnType<typeof createInput>,
) {
  await createApprovedPlan(store, input);
  const ready = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: input.artifactDigest,
    provisionalRevision: input.provisionalRevision,
    idempotencyKey: randomUUID(),
  });
  return ready.job;
}

test("BLOCK requests rework and advances only invalidated check generations", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  const original = await createReadyJob(store, input);

  const result = await store.recordAuditBlock({
    ...auditAuthority,
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
  assert.deepEqual(original.policy.requiredGenerations, initialFinnyPolicy(TEST_FINNY_EVALUATOR).requiredGenerations);
});

test("duplicate BLOCK submissions return the original transition without advancing policy again", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createReadyJob(store, input);
  const firstSubmission = {
    ...auditAuthority,
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
    ...auditAuthority,
    ...firstSubmission,
    generation: 3,
    artifactDigest: "artifact-sha256-v2",
    findings: [{ code: "LINEAGE_2", message: "Source binding remains incomplete" }],
    idempotencyKey: randomUUID(),
  });

  const duplicate = await store.recordAuditBlock(firstSubmission);

  assert.equal(duplicate.deduped, true);
  assert.deepEqual(duplicate.events, first.events);
  assert.equal(duplicate.job.policy.requiredGenerations["lineage.binding"], 4);
  assert.equal((await store.getJob(input.scopeId, input.id))?.policy.requiredGenerations["lineage.binding"], 4);
});

test("stale and wrong-scope audit events fail without changing authoritative state", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createReadyJob(store, input);
  const submission = {
    ...auditAuthority,
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
  assert.deepEqual(
    (await store.listEvents(input.scopeId, input.id)).filter((event) => event.type !== "artifact_ready"),
    [],
  );
  assert.ok(((await store.getJob(input.scopeId, input.id))?.eventHead ?? 0) > 0);
});

test("artifact and audit events expose the latest server sequence", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createApprovedPlan(store, input);
  const artifact = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: input.artifactDigest,
    provisionalRevision: input.provisionalRevision,
    idempotencyKey: randomUUID(),
  });
  const passed = await store.recordAuditPassed({
    ...auditAuthority,
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
  await createReadyJob(store, input);
  const result = await store.recordAuditBlock({
    ...auditAuthority,
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
  assert.deepEqual(result.job.policy, initialFinnyPolicy(TEST_FINNY_EVALUATOR));
});

test("BLOCK rejects findings beyond the bounded event contract", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = { ...createInput(), findingPolicy: { ...findingPolicy, maxFindings: 20 } };
  await createReadyJob(store, input);

  await assert.rejects(
    store.recordAuditBlock({
      ...auditAuthority,
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
  assert.deepEqual(
    (await store.listEvents(input.scopeId, input.id)).filter((event) => event.type !== "artifact_ready"),
    [],
  );
});

test("an idempotency key cannot replay events from another job or scope", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const first = createInput();
  const second = { ...createInput(), scopeId: "personal:U2" };
  await createApprovedPlan(store, first);
  await createApprovedPlan(store, second);
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
  await createReadyJob(store, input);
  const base = {
    ...auditAuthority,
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
  assert.deepEqual(
    (await store.listEvents(input.scopeId, input.id)).filter((event) => event.type !== "artifact_ready"),
    [],
  );
});

test("finalized jobs reject new event transitions", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createReadyJob(store, input);

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
      ...auditAuthority,
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
      ...auditAuthority,
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
  await createReadyJob(store, input);
  const submission = {
    ...auditAuthority,
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
  assert.deepEqual(
    (await store.listEvents(input.scopeId, input.id)).filter((event) => event.type !== "artifact_ready"),
    [],
  );
});

test("artifact replacement requires an authoritative rework request", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createReadyJob(store, input);

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
    ...auditAuthority,
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
      generation: 3,
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
    ...auditAuthority,
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 3,
    artifactDigest: "artifact-sha256-v2",
    evidenceDigest: "lineage-evidence-v2",
    idempotencyKey: randomUUID(),
  });
  assert.equal(passed.events[0]?.payload.generation, 3);
});

test("re-audit waits for a new artifact to consume the rework request", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createReadyJob(store, input);
  await store.recordAuditBlock({
    ...auditAuthority,
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
      ...auditAuthority,
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
  await createReadyJob(store, input);

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
    ...auditAuthority,
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
  await createReadyJob(store, input);

  await assert.rejects(
    store.recordAuditBlock({
      ...auditAuthority,
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

test("artifact_ready authoritatively binds a job created before its artifact", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createApprovedPlan(store, input);

  const ready = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "artifact-created-after-approval",
    provisionalRevision: "revision-created-after-approval",
    idempotencyKey: randomUUID(),
  });

  assert.equal(ready.job.artifactDigest, "artifact-created-after-approval");
  assert.equal(ready.job.provisionalRevision, "revision-created-after-approval");
  assert.equal(ready.events[0]?.type, "artifact_ready");
  for (const checkId of FINNY_CHECK_IDS) {
    await store.recordAttestation({
      id: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.id,
      checkId,
      generation: 1,
      verdict: "pass",
      evidenceDigest: `post-ready-${checkId}`,
      artifactDigest: "artifact-created-after-approval",
      issuerPrincipalId: "U-auditor",
      issuerRunId: "run-auditor-post-ready",
      idempotencyKey: randomUUID(),
    });
  }
  const receipt = await store.finalize(
    { scopeId: input.scopeId, jobId: input.id, idempotencyKey: randomUUID() },
    async () => "post-ready-receipt",
  );
  assert.equal(receipt.payload.artifactDigest, "artifact-created-after-approval");
  assert.equal(receipt.payload.provisionalRevision, "revision-created-after-approval");
});

test("PASS atomically records a current artifact-bound attestation and provenance event", async () => {
  const connectionString = testDatabaseUrl();
  const store = createPostgresFinnyStore(connectionString);
  const input = createInput();
  await createReadyJob(store, input);
  const idempotencyKey = randomUUID();

  const passed = await store.recordAuditPassed({
    ...auditAuthority,
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 1,
    artifactDigest: input.artifactDigest,
    evidenceDigest: "evidence-sha256-pass",
    issuerPrincipalId: "auditor-principal",
    issuerRunId: "auditor-run",
    idempotencyKey,
  });

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  const attestations = await client.query("SELECT * FROM finny_attestations WHERE job_id=$1", [input.id]);
  await client.end();
  assert.equal(attestations.rowCount, 1);
  assert.equal(attestations.rows[0]?.verdict, "pass");
  assert.equal(attestations.rows[0]?.evidence_digest, "evidence-sha256-pass");
  assert.equal(attestations.rows[0]?.artifact_digest, input.artifactDigest);
  assert.equal(attestations.rows[0]?.issuer_principal_id, "auditor-principal");
  assert.equal(attestations.rows[0]?.issuer_run_id, "auditor-run");
  assert.equal(passed.job.ledgerHead, Number(attestations.rows[0]?.seq));
  assert.equal(passed.events[0]?.payload.issuerPrincipalId, "auditor-principal");
  assert.equal(passed.events[0]?.payload.issuerRunId, "auditor-run");
});

test("BLOCK atomically records evidence-bound attestation and rejects replay substitution", async () => {
  const connectionString = testDatabaseUrl();
  const store = createPostgresFinnyStore(connectionString);
  const input = createInput();
  await createReadyJob(store, input);
  const submission = {
    ...auditAuthority,
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding" as const,
    generation: 1,
    artifactDigest: input.artifactDigest,
    evidenceDigest: "evidence-sha256-block",
    issuerPrincipalId: "auditor-principal",
    issuerRunId: "auditor-run",
    findings: [{ code: "LINEAGE", message: "Missing source binding" }],
    changeKinds: ["lineage" as const],
    resolution: { kind: "rework" as const },
    idempotencyKey: randomUUID(),
  };

  const blocked = await store.recordAuditBlock(submission);
  const blockedEvent = blocked.events.find(
    (event): event is FinnyJobEvent<"audit_blocked"> => event.type === "audit_blocked",
  );
  assert.equal(blockedEvent?.payload.evidenceDigest, "evidence-sha256-block");
  assert.equal(blockedEvent?.payload.issuerPrincipalId, "auditor-principal");
  assert.equal(blockedEvent?.payload.issuerRunId, "auditor-run");
  assert.ok(blocked.job.ledgerHead > 0);
  await assert.rejects(
    store.recordAuditBlock({ ...submission, evidenceDigest: "substituted-evidence" }),
    /idempotency key was reused/i,
  );

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  const attestations = await client.query("SELECT * FROM finny_attestations WHERE job_id=$1", [input.id]);
  await client.end();
  assert.equal(attestations.rowCount, 1);
  assert.equal(attestations.rows[0]?.verdict, "block");
  assert.equal(attestations.rows[0]?.evidence_digest, "evidence-sha256-block");
  assert.equal(attestations.rows[0]?.issuer_principal_id, "auditor-principal");
  assert.equal(attestations.rows[0]?.issuer_run_id, "auditor-run");
  assert.equal(blocked.job.ledgerHead, Number(attestations.rows[0]?.seq));
});

test("replacement artifact bytes invalidate every required check before finalization", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createReadyJob(store, input);
  for (const checkId of FINNY_CHECK_IDS) {
    await store.recordAuditPassed({
      ...auditAuthority,
      scopeId: input.scopeId,
      jobId: input.id,
      checkId,
      generation: 1,
      artifactDigest: input.artifactDigest,
      evidenceDigest: `old-${checkId}`,
      idempotencyKey: randomUUID(),
    });
  }
  await store.recordAuditBlock({
    ...auditAuthority,
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "LINEAGE", message: "Replace the artifact" }],
    changeKinds: ["lineage"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });
  const replacement = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "artifact-sha256-v2",
    provisionalRevision: "delivery-revision-2",
    idempotencyKey: randomUUID(),
  });
  assert.deepEqual(
    replacement.job.policy.requiredGenerations,
    Object.fromEntries(FINNY_CHECK_IDS.map((checkId) => [checkId, checkId === "lineage.binding" ? 3 : 2])),
  );
  await assert.rejects(
    store.finalize(
      { scopeId: input.scopeId, jobId: input.id, idempotencyKey: randomUUID() },
      async () => "must-not-sign",
    ),
    /stale generation|missing/i,
  );
});

test("byte-identical rework preserves selective check invalidation", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await createReadyJob(store, input);
  await store.recordAuditBlock({
    ...auditAuthority,
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding",
    generation: 1,
    artifactDigest: input.artifactDigest,
    findings: [{ code: "LINEAGE", message: "Repair file lineage metadata" }],
    changeKinds: ["lineage"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });
  const replacement = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: input.artifactDigest,
    provisionalRevision: "delivery-revision-identical",
    idempotencyKey: randomUUID(),
  });
  assert.equal(replacement.job.policy.requiredGenerations["source.completeness"], 1);
  assert.equal(replacement.job.policy.requiredGenerations["lineage.binding"], 2);
});
