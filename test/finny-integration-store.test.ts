import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPostgresFinnyIntegrationStore } from "../src/finny/integration-postgres-store.ts";
import { createFinnyToolServiceFactory } from "../src/finny/integration.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createPostgresFinnyRuntimeStore } from "../src/finny/runtime-postgres-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
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
    policy: initialFinnyPolicy(),
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
    policy: initialFinnyPolicy(),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  };
  const intentParent = { ...parent, jobId: intentJob.id, requestId: randomUUID() };
  await integration.createPlanIntent({ job: intentJob, parent: intentParent });
  assert.deepEqual(await integration.pendingPlanIntents(), [{ job: intentJob, parent: intentParent }]);
  await jobs.createJob(intentJob);
  await integration.completePlanIntent(intentParent);
  assert.deepEqual(await integration.pendingPlanIntents(), []);
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
    policy: initialFinnyPolicy(),
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
    policy: initialFinnyPolicy(),
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
