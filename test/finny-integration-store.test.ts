import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPostgresFinnyIntegrationStore } from "../src/finny/integration-postgres-store.ts";
import { createFinnyApprovalService } from "../src/finny/approval-service.ts";
import { createFinnyToolServiceFactory } from "../src/finny/integration.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createPostgresFinnyRuntimeStore } from "../src/finny/runtime-postgres-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("durably preserves exact parent binding, destination, and artifact proposal idempotency", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  const job = await jobs.createJob({
    id: randomUUID(),
    scopeId: "personal:U1",
    plan: {
      title: "Pack",
      phases: [{ name: "Build", owner: "Producer", dependencies: [] }],
      certification: "Audit",
      deliverable: "Book",
      destination: "Thread",
      clarifications: [],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  });
  const parent = {
    scopeId: job.scopeId,
    jobId: job.id,
    requestId: randomUUID(),
    actorId: "U1",
    originThreadRef: job.originThreadRef,
    destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
    binding: {
      schema: "finny-parent-binding.v1" as const,
      sessionId: randomUUID(),
      runId: randomUUID(),
      scopeId: job.scopeId,
      context: {
        actor: { id: "U1", type: "internal" as const },
        conversation: {
          kind: "dm" as const,
          threadRef: job.originThreadRef,
          audience: [{ id: "U1", type: "internal" as const }],
        },
        surface: "slack",
      },
    },
  };
  await integration.createApprovalBoundParent(parent);
  assert.deepEqual(await integration.getParent(job.scopeId, job.id), parent);
  assert.deepEqual(
    (await integration.pendingApprovalCards()).map((record) => record.jobId),
    [job.id],
  );
  const proposal = {
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: randomUUID(),
    runId: randomUUID(),
    artifactDigest: "digest-1",
    provisionalRevision: "r1",
    idempotencyKey: randomUUID(),
  };
  await integration.saveArtifactProposal(proposal);
  assert.deepEqual(await integration.getArtifactProposal(proposal.idempotencyKey), proposal);
  await integration.saveArtifactProposal(proposal);
  await assert.rejects(
    () => integration.saveArtifactProposal({ ...proposal, artifactDigest: "other" }),
    /idempotency conflict/,
  );
  const intentJob = {
    id: randomUUID(),
    scopeId: "personal:U1",
    plan: {
      title: "Recover",
      phases: [{ name: "Build", owner: "Producer", dependencies: [] }],
      certification: "Audit",
      deliverable: "Book",
      destination: "Thread",
      clarifications: [],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  };
  const intentParent = { ...parent, jobId: intentJob.id, requestId: randomUUID() };
  await integration.createPlanIntent({ job: intentJob, parent: intentParent });
  const migrationDb = createPgPool(url);
  await migrationDb.q("UPDATE finny_plan_intents SET parent_input=parent_input->'parent' WHERE job_id=$1", [
    intentJob.id,
  ]);
  await migrationDb.q("DELETE FROM qm_schema_migrations WHERE id='finny/integration/0002-plan-clarification'");
  const upgradedIntegration = createPostgresFinnyIntegrationStore(url);
  assert.deepEqual(await upgradedIntegration.pendingPlanIntents(), [{ job: intentJob, parent: intentParent }]);
  await jobs.createJob(intentJob);
  await upgradedIntegration.completePlanIntent(intentParent);
  assert.deepEqual(await upgradedIntegration.pendingPlanIntents(), []);
});

test("startup recovery finds approved jobs whose producer dispatch is incomplete", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const runtime = createPostgresFinnyRuntimeStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  const job = await jobs.createJob({
    id: randomUUID(),
    scopeId: "personal:U1",
    plan: {
      title: "Pack",
      phases: [{ name: "Build", owner: "Producer", dependencies: [] }],
      certification: "Audit",
      deliverable: "Book",
      destination: "Thread",
      clarifications: [],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  });
  const requestId = randomUUID();
  await jobs.createApprovalRequest({ scopeId: job.scopeId, jobId: job.id, requestId, authorizedActorId: "U1" });
  await integration.createApprovalBoundParent({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    originThreadRef: job.originThreadRef,
    destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
    binding: {
      schema: "finny-parent-binding.v1",
      sessionId: randomUUID(),
      runId: randomUUID(),
      scopeId: job.scopeId,
      context: {
        actor: { id: "U1", type: "internal" as const },
        conversation: {
          kind: "dm" as const,
          threadRef: job.originThreadRef,
          audience: [{ id: "U1", type: "internal" as const }],
        },
        surface: "slack",
      },
    },
  });
  await jobs.recordApproval({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: job.originThreadRef,
    decidedAt: Date.now(),
  });
  await runtime.currentBinding(randomUUID());
  const parentSessionId = randomUUID();
  const producerSessionId = randomUUID();
  const auditorSessionId = randomUUID();
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId,
    parentRunId: randomUUID(),
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId,
    producerRunId: randomUUID(),
    auditorSessionId,
    auditorRunId: randomUUID(),
    producerPrincipalId: "producer",
    auditorPrincipalId: "auditor",
  });
  const originalProducer = await runtime.currentBinding(producerSessionId);
  assert.equal(
    await runtime.claimParentTurn({
      sessionId: producerSessionId,
      runId: randomUUID(),
      scopeId: job.scopeId,
      principalId: "producer",
    }),
    null,
  );
  assert.deepEqual(await runtime.currentBinding(producerSessionId), originalProducer);
  const factory = createFinnyToolServiceFactory({ runtime } as any);
  assert.equal(
    await factory.forTurn({
      actor: { id: "U1", type: "internal" },
      scopeId: job.scopeId,
      sessionId: producerSessionId,
      runId: randomUUID(),
      originThreadRef: job.originThreadRef,
      destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
      parent: false,
      parentBinding: {
        schema: "finny-parent-binding.v1",
        sessionId: producerSessionId,
        runId: randomUUID(),
        scopeId: job.scopeId,
        context: {
          actor: { id: "U1", type: "internal" },
          conversation: { kind: "dm", threadRef: "dm:D1:100.1", audience: [{ id: "U1", type: "internal" }] },
          surface: "slack",
        },
      },
    }),
    undefined,
  );
  assert.deepEqual(await runtime.currentBinding(producerSessionId), originalProducer);
  const currentRunId = randomUUID();
  assert.equal(
    (
      await runtime.advanceWorkerRun({
        sessionId: producerSessionId,
        expectedRunId: originalProducer!.runId,
        runId: currentRunId,
        scopeId: job.scopeId,
        expiresAt: Date.now() + 60_000,
      })
    )?.runId,
    currentRunId,
  );
  await runtime.bindWorker({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: producerSessionId,
    runId: originalProducer!.runId,
    role: "producer",
    principalId: "producer",
    epoch: 0,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal((await runtime.currentBinding(producerSessionId))?.runId, currentRunId);
  await runtime.retireJob(job.scopeId, job.id);
  const secondJob = await jobs.createJob({
    id: randomUUID(),
    scopeId: job.scopeId,
    plan: {
      title: "Second",
      phases: [{ name: "Build", owner: "Producer", dependencies: [] }],
      certification: "Audit",
      deliverable: "Book",
      destination: "Thread",
      clarifications: [],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: job.originThreadRef,
  });
  await runtime.bindParent({
    scopeId: secondJob.scopeId,
    jobId: secondJob.id,
    sessionId: parentSessionId,
    runId: randomUUID(),
    principalId: "U1",
  });
  assert.equal((await runtime.currentBinding(parentSessionId))?.jobId, secondJob.id);
  assert.deepEqual(
    (await integration.approvedIncomplete()).map((record) => record.jobId),
    [job.id],
  );
});

test("material clarification keeps approval fail closed and restart recovery releases only the recommendation", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  const jobInput = {
    id: randomUUID(),
    scopeId: "personal:U1",
    plan: {
      title: "Material basis",
      phases: [{ name: "Build", owner: "Producer", dependencies: [] }],
      certification: "Audit",
      deliverable: "Book",
      destination: "Thread",
      clarifications: [{ question: "Which basis?", answer: "Signed contracts" }],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  };
  const parent = {
    scopeId: jobInput.scopeId,
    jobId: jobInput.id,
    requestId: randomUUID(),
    actorId: "U1",
    originThreadRef: jobInput.originThreadRef,
    destination: { type: "slack" as const, target: "C1:100.1", threadTs: "100.1" },
    binding: {
      schema: "finny-parent-binding.v1" as const,
      sessionId: randomUUID(),
      runId: randomUUID(),
      scopeId: jobInput.scopeId,
      context: {
        actor: { id: "U1", type: "internal" as const },
        conversation: {
          kind: "dm" as const,
          threadRef: jobInput.originThreadRef,
          audience: [{ id: "U1", type: "internal" as const }],
        },
        surface: "slack",
      },
    },
  };
  const clarification = {
    scopeId: jobInput.scopeId,
    jobId: jobInput.id,
    requestId: randomUUID(),
    authorizedActorId: "U1",
    question: "Which basis?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: `clarification:${jobInput.id}`,
  };
  await jobs.getJob(jobInput.scopeId, jobInput.id);
  await integration.createPlanIntent({ job: jobInput, parent, clarification });
  await jobs.createJob(jobInput);
  const restarted = createPostgresFinnyIntegrationStore(url);
  assert.deepEqual(await restarted.pendingPlanIntents(), [{ job: jobInput, parent, clarification }]);
  await restarted.completePlanIntent(parent, clarification);
  assert.deepEqual(
    (await restarted.pendingClarificationCards()).map((record) => ({
      jobId: record.jobId,
      requestId: record.clarificationRequestId,
      question: record.question,
    })),
    [{ jobId: jobInput.id, requestId: clarification.requestId, question: clarification.question }],
  );
  assert.deepEqual(await restarted.pendingApprovalCards(), []);
  assert.equal((await jobs.getApprovalRequest(parent.requestId))?.readyAt, undefined);
  await assert.rejects(
    jobs.recordApproval({
      scopeId: parent.scopeId,
      jobId: parent.jobId,
      requestId: parent.requestId,
      actorId: parent.actorId,
      action: "approve",
      originThreadRef: parent.originThreadRef,
      decidedAt: Date.now(),
    }),
    /not ready/i,
  );
  let readyCallbacks = 0;
  const approvals = createFinnyApprovalService({
    store: jobs,
    identity: {
      resolve: (actor) => ({ id: actor.externalId, type: "internal" as const }),
      isInternal: (principal) => principal.type === "internal",
    },
    onApproved: async () => undefined,
    onClarificationReady: async () => {
      readyCallbacks += 1;
    },
  });
  assert.equal(await approvals.pending(parent.requestId), null);
  assert.deepEqual(
    await approvals.decide({
      requestId: clarification.requestId,
      actor: { externalId: "U1" },
      slack: { channel: "C1", messageTs: "100.2", threadTs: "100.1" },
      decision: { kind: "clarification", action: "select", optionId: "contracts" },
    }),
    {
      kind: "result",
      card: {
        title: "Clarification recorded",
        status: "passed",
        summary: "Signed contracts. The plan is ready for approval.",
      },
    },
  );
  assert.equal(readyCallbacks, 1);
  assert.equal((await approvals.pending(parent.requestId))?.kind, "plan");
  assert.ok((await jobs.getApprovalRequest(parent.requestId))?.readyAt);
  assert.deepEqual(
    (await createPostgresFinnyIntegrationStore(url).pendingApprovalCards()).map((record) => record.jobId),
    [jobInput.id],
  );
});

test("nonrecommended and Other clarification decisions permanently withhold the stale plan", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  for (const decision of [{ kind: "option" as const, optionId: "invoices" }, { kind: "other" as const }]) {
    const job = await jobs.createJob({
      id: randomUUID(),
      scopeId: "personal:U1",
      plan: {
        title: "Material basis",
        phases: [{ name: "Build", owner: "Producer", dependencies: [] }],
        certification: "Audit",
        deliverable: "Book",
        destination: "Thread",
        clarifications: [{ question: "Which basis?", answer: "Signed contracts" }],
      },
      policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
      findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
      originThreadRef: "slack:C1:100.1",
    });
    const requestId = randomUUID();
    const clarificationId = randomUUID();
    await integration.createApprovalBoundParent(
      {
        scopeId: job.scopeId,
        jobId: job.id,
        requestId,
        actorId: "U1",
        originThreadRef: job.originThreadRef,
        destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
        binding: {
          schema: "finny-parent-binding.v1",
          sessionId: randomUUID(),
          runId: randomUUID(),
          scopeId: job.scopeId,
          context: {
            actor: { id: "U1", type: "internal" },
            conversation: {
              kind: "dm",
              threadRef: job.originThreadRef,
              audience: [{ id: "U1", type: "internal" }],
            },
            surface: "slack",
          },
        },
      },
      {
        scopeId: job.scopeId,
        jobId: job.id,
        requestId: clarificationId,
        authorizedActorId: "U1",
        question: "Which basis?",
        options: [
          { id: "contracts", label: "Signed contracts" },
          { id: "invoices", label: "Issued invoices" },
        ],
        recommendedOptionId: "contracts",
        idempotencyKey: `clarification:${job.id}`,
      },
    );
    await jobs.recordClarificationDecision({
      requestId: clarificationId,
      actorId: "U1",
      originThreadRef: job.originThreadRef,
      decision,
      decidedAt: Date.now(),
    });
    assert.equal((await jobs.getApprovalRequest(requestId))?.readyAt, undefined);
    assert.equal(
      (await integration.pendingApprovalCards()).some((record) => record.jobId === job.id),
      false,
    );
  }
});
