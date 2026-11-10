import { TEST_FINNY_EVALUATOR, testDeterministicAuthority } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createFinnyRuntimeCoordinator, reconcileFinnyRuntimeRecoveries } from "../src/finny/runtime-coordinator.ts";
import { createPostgresFinnyRuntimeStore, type FinnyRuntimeRecovery } from "../src/finny/runtime-postgres-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createFinnyWorkerGrants } from "../src/finny/worker-grants.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

async function approvedJob() {
  const connectionString = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(connectionString);
  const job = await jobs.createJob({
    id: randomUUID(),
    scopeId: "personal:U1",
    plan: {
      title: "Finance pack",
      phases: [{ name: "Produce", owner: "Producer", dependencies: [] }],
      certification: "Independent audit",
      deliverable: "Workbook",
      destination: "Origin thread",
      clarifications: [],
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "runtime-test", maxFindings: 4, maxCodeLength: 40, maxMessageLength: 200 },
    originThreadRef: `slack:C1:${randomUUID()}`,
  });
  const requestId = randomUUID();
  await jobs.createApprovalRequest({ scopeId: job.scopeId, jobId: job.id, requestId, authorizedActorId: "U1" });
  await jobs.recordApproval({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: job.originThreadRef,
    decidedAt: Date.now(),
  });
  return { jobs, job, connectionString };
}

function runtimeDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function coreRuntimeAuthority() {
  return {
    artifactBinding: {
      async resolve(input: { idempotencyKey: string }) {
        if (input.idempotencyKey === "artifact-2") {
          return { artifactDigest: "artifact-v2", provisionalRevision: "revision-2" };
        }
        return { artifactDigest: "artifact-sha256", provisionalRevision: "revision-1" };
      },
    },
    evidenceAuthority: {
      async resolve(input: { evidenceFileId: string; checkId: string; verdict: "pass" | "block" }) {
        return {
          evidenceDigest: input.evidenceFileId,
          ...testDeterministicAuthority(input.checkId, input.verdict),
        };
      },
    },
    workerPolicy: {
      credentials() {
        return { principalId: "U1", expiresAt: Date.now() + 60_000 };
      },
      task(_job: unknown, role: "producer" | "auditor") {
        return role === "producer" ? "Create the approved workbook" : "Audit the current artifact independently";
      },
    },
  };
}

test("admits producer and Auditor sequentially and dispatches only the producer grant after approval", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const grants = createFinnyWorkerGrants(jobs, "runtime-test-secret");
  const opened: string[] = [];
  const openTasks: string[] = [];
  let activeAdmissions = 0;
  let maxConcurrentAdmissions = 0;
  const sessions = {
    async open(input: { name?: string; task: string }) {
      activeAdmissions += 1;
      maxConcurrentAdmissions = Math.max(maxConcurrentAdmissions, activeAdmissions);
      opened.push(input.name ?? "");
      openTasks.push(input.task);
      await Promise.resolve();
      activeAdmissions -= 1;
      const role = input.name === "Finny Auditor" ? "auditor" : "producer";
      return { ok: true as const, sessionId: `${role}-session`, runId: `${role}-run`, title: input.name ?? role };
    },
  };
  const dispatched: Array<{
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    message: string;
    role: "producer" | "auditor";
    principalId: string;
    expiresAt: number;
  }> = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants,
    sessions,
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message);
      },
    },
    ...coreRuntimeAuthority(),
  });

  const result = await coordinator.afterApproved({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    idempotencyKey: "approved-1",
  });

  assert.equal(result, undefined);
  assert.deepEqual(opened, ["Finny Producer", "Finny Auditor"]);
  assert.equal(maxConcurrentAdmissions, 1);
  assert.ok(openTasks.every((task) => !task.includes("approved workbook") && !task.includes("current artifact")));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.sessionId, "producer-session");
  assert.equal(dispatched[0]?.runId, "producer-run");
  assert.match(dispatched[0]?.message ?? "", /Create the approved workbook/);
  assert.equal(dispatched[0]?.role, "producer");
  assert.equal((await runtime.currentBinding("parent-session"))?.role, "parent");
  assert.equal((await runtime.currentBinding("producer-session"))?.runId, "producer-run");
  assert.equal((await runtime.currentBinding("auditor-session"))?.role, "auditor");
});

test("parent binding refreshes its run only for the same job and principal", async () => {
  const { job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const sessionId = randomUUID();
  const firstRunId = randomUUID();
  const nextRunId = randomUUID();
  await runtime.bindParent({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId,
    runId: firstRunId,
    principalId: "U1",
  });
  await runtime.bindParent({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId,
    runId: nextRunId,
    principalId: "U1",
  });
  assert.equal((await runtime.currentBinding(sessionId))?.runId, nextRunId);
  await assert.rejects(
    runtime.bindParent({
      scopeId: job.scopeId,
      jobId: job.id,
      sessionId,
      runId: randomUUID(),
      principalId: "U2",
    }),
    /parent runtime binding idempotency conflict/,
  );
  assert.equal((await runtime.currentBinding(sessionId))?.runId, nextRunId);
});

test("rejects artifact readiness from a stale producer run", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("unexpected dispatch");
      },
    },
    ...coreRuntimeAuthority(),
  });

  await assert.rejects(
    coordinator.artifactReady({
      sessionId: "producer-session",
      runId: "stale-run",
      scopeId: job.scopeId,
      jobId: job.id,
      idempotencyKey: "artifact-1",
    }),
    /current producer/i,
  );
  assert.equal((await jobs.getJob(job.scopeId, job.id))?.artifactDigest, undefined);
});

test("issues and dispatches the Auditor grant only after artifact readiness", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const dispatched: Array<{
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    message: string;
    role: "producer" | "auditor";
    principalId: string;
    expiresAt: number;
  }> = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message);
      },
    },
    ...coreRuntimeAuthority(),
  });

  await coordinator.artifactReady({
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-1",
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.sessionId, "auditor-session");
  assert.equal(dispatched[0]?.runId, "auditor-run");
  assert.match(dispatched[0]?.message ?? "", /Audit the current artifact independently/);
  assert.equal(dispatched[0]?.role, "auditor");
});

test("a BLOCK wakes the bound producer with policy-bounded findings", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-1",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const dispatched: Array<{
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    message: string;
    role: "producer" | "auditor";
    principalId: string;
    expiresAt: number;
  }> = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message);
      },
    },
    escalationDecision: {
      async decide() {
        return { kind: "rework" as const };
      },
    },
    ...coreRuntimeAuthority(),
  });

  await coordinator.auditBlocked({
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding",
    generation: 1,
    evidenceFileId: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Source lineage is incomplete" }],
    idempotencyKey: "block-1",
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.sessionId, "producer-session");
  assert.equal(dispatched[0]?.runId, "producer-run");
  assert.match(dispatched[0]?.message ?? "", /Source lineage is incomplete/);
  assert.equal(await runtime.currentBinding("auditor-session"), null);
});

test("the next artifact creates a fresh independent Auditor run and grant", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-v1",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-1",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session-1",
    auditorRunId: "auditor-run-1",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const dispatched: Array<{
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    message: string;
    role: "producer" | "auditor";
    principalId: string;
    expiresAt: number;
  }> = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        assert.equal(input.name, "Finny Auditor");
        return { ok: true as const, sessionId: "auditor-session-2", runId: "auditor-run-2", title: "Finny Auditor" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message);
      },
    },
    escalationDecision: {
      async decide() {
        return { kind: "rework" as const };
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.auditBlocked({
    sessionId: "auditor-session-1",
    runId: "auditor-run-1",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-v1",
    checkId: "lineage.binding",
    generation: 1,
    evidenceFileId: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Repair lineage" }],
    idempotencyKey: "block-1",
  });

  await coordinator.artifactReady({
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-2",
  });

  assert.equal((await runtime.currentBinding("auditor-session-2"))?.runId, "auditor-run-2");
  assert.equal((await runtime.currentBinding("auditor-session-2"))?.epoch, 2);
  assert.equal(dispatched.at(-1)?.sessionId, "auditor-session-2");
  assert.match(dispatched.at(-1)?.message ?? "", /Audit the current artifact independently/);
});

test("replaying approved dispatch is idempotent", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const dispatched: string[] = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        const role = input.name === "Finny Auditor" ? "auditor" : "producer";
        return { ok: true as const, sessionId: `${role}-session`, runId: `${role}-run`, title: input.name ?? role };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message.idempotencyKey);
      },
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    idempotencyKey: "approved-replay",
  };

  await coordinator.afterApproved(input);
  await coordinator.afterApproved(input);

  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0] ?? "", /^finny:.*:producer-grant:/);
});

test("a terminal Producer run receives a new idempotent grant generation", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const dispatched: string[] = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        const role = input.name === "Finny Auditor" ? "auditor" : "producer";
        return { ok: true as const, sessionId: `${role}-session`, runId: `${role}-run`, title: input.name ?? role };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message.idempotencyKey);
      },
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    idempotencyKey: "approved-retry",
  };

  await coordinator.afterApproved(input);
  await runtime.advanceWorkerRun({
    sessionId: "producer-session",
    expectedRunId: "producer-run",
    runId: "terminal-producer-run",
    scopeId: job.scopeId,
    expiresAt: Date.now() + 60_000,
  });
  await coordinator.afterApproved(input);

  assert.equal(dispatched.length, 2);
  assert.notEqual(dispatched[0], dispatched[1]);
  assert.match(dispatched[1] ?? "", /:producer-grant:terminal-producer-run$/);
});

test("an externally approved escalation stops worker actions instead of reworking", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-1",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  let dispatched = false;
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        dispatched = true;
      },
    },
    escalationDecision: {
      async decide() {
        return { kind: "escalate" as const, reason: "Controller approved stop" };
      },
    },
    ...coreRuntimeAuthority(),
  });

  await coordinator.auditBlocked({
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding",
    generation: 1,
    evidenceFileId: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Cannot establish lineage" }],
    idempotencyKey: "block-stop",
  });

  assert.equal(dispatched, false);
  assert.equal(await runtime.currentBinding("producer-session"), null);
  assert.equal(await runtime.currentBinding("auditor-session"), null);
  assert.ok((await jobs.getJob(job.scopeId, job.id))?.unresolvedEscalationSequence);
});

test("authenticated Pi reader returns the current active worker binding and job authority", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const { createFinnyCurrentJobReader } = await import("../src/finny/runtime-reader.ts");
  const reader = createFinnyCurrentJobReader({
    jobs,
    runtime,
    authenticateSession: async (sessionId) => sessionId === "producer-session",
  });

  const current = await reader.readCurrentJob({ sessionId: "producer-session" });

  assert.deepEqual(current, {
    schema: "finny-authoritative-job.v1",
    scopeId: job.scopeId,
    jobId: job.id,
    runId: "producer-run",
    role: "producer",
    eventSeq: 0,
    status: "producing",
    policyVersion: job.policy.policyVersion,
    planDigest: job.planDigest,
    artifactDigest: null,
    requiredGenerations: job.policy.requiredGenerations,
  });
  await assert.rejects(reader.readCurrentJob({ sessionId: "auditor-session" }), /authenticate/i);
});

test("rejects audit completion from the producer role", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-1",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("unexpected dispatch");
      },
    },
    ...coreRuntimeAuthority(),
  });

  await assert.rejects(
    coordinator.auditPassed({
      sessionId: "producer-session",
      runId: "producer-run",
      scopeId: job.scopeId,
      jobId: job.id,
      artifactDigest: "artifact-sha256",
      checkId: "lineage.binding",
      generation: 1,
      evidenceFileId: "evidence-sha256",
      idempotencyKey: "pass-1",
    }),
    /current auditor/i,
  );
});

test("replaying the same BLOCK is idempotent without duplicate producer wake", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-1",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const dispatched: string[] = [];
  let resolution: { kind: "rework" } | { kind: "escalate"; reason: string } = { kind: "rework" };
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message.idempotencyKey);
      },
    },
    escalationDecision: {
      async decide() {
        return resolution;
      },
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding" as const,
    generation: 1,
    evidenceFileId: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Repair lineage" }],
    idempotencyKey: "block-replay",
  };

  await coordinator.auditBlocked(input);
  resolution = { kind: "escalate", reason: "Changed later" };
  await coordinator.auditBlocked(input);

  assert.deepEqual(dispatched, ["block-replay:producer-rework"]);
});

test("concurrent approved callbacks converge through dispatcher idempotency", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const delivered = new Set<string>();
  let dispatchCalls = 0;
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        const role = input.name === "Finny Auditor" ? "auditor" : "producer";
        return { ok: true as const, sessionId: `${role}-session`, runId: `${role}-run`, title: input.name ?? role };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        const visible = await createPgPool(connectionString).q(
          "SELECT delivered_at FROM finny_runtime_dispatches WHERE idempotency_key=$1",
          [message.idempotencyKey],
        );
        assert.equal(visible.length, 1, "dispatch intent must commit before the callback runs");
        dispatchCalls += 1;
        delivered.add(message.idempotencyKey);
      },
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    idempotencyKey: "approved-concurrent",
  };

  await Promise.all([coordinator.afterApproved(input), coordinator.afterApproved(input)]);

  assert.equal(dispatchCalls, 1);
  assert.equal(delivered.size, 1);
  assert.match([...delivered][0] ?? "", /^finny:.*:producer-grant:/);
});

test("artifact readiness derives artifact and Auditor grant authority from Core dependencies", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const realGrants = createFinnyWorkerGrants(jobs, "runtime-test-secret");
  let issuedPrincipal = "";
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: {
      issueProducer: realGrants.issueProducer,
      async issueAuditor(input) {
        issuedPrincipal = input.principalId;
        return realGrants.issueAuditor(input);
      },
    },
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(input) {
        issuedPrincipal = input.principalId;
      },
    },
    evidenceAuthority: coreRuntimeAuthority().evidenceAuthority,
    artifactBinding: {
      async resolve() {
        return { artifactDigest: "core-artifact", provisionalRevision: "core-revision" };
      },
    },
    workerPolicy: {
      credentials() {
        return { principalId: "core-principal", expiresAt: Date.now() + 60_000 };
      },
      task(_job, role) {
        return role === "producer" ? "Core producer task" : "Core Auditor task";
      },
    },
  });

  await coordinator.artifactReady({
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-core",
  });

  const current = await jobs.getJob(job.scopeId, job.id);
  assert.equal(current?.artifactDigest, "core-artifact");
  assert.equal(current?.provisionalRevision, "core-revision");
  assert.equal(issuedPrincipal, "core-principal");
});

test("a completed artifact action replays after the producer binding retires", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const delivered = new Set<string>();
  let resolvedArtifact = { artifactDigest: "artifact-sha256", provisionalRevision: "revision-1" };
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        delivered.add(message.idempotencyKey);
      },
    },
    evidenceAuthority: coreRuntimeAuthority().evidenceAuthority,
    workerPolicy: coreRuntimeAuthority().workerPolicy,
    artifactBinding: {
      async resolve() {
        return resolvedArtifact;
      },
    },
  });
  const input = {
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-replay-retired",
  };

  await coordinator.artifactReady(input);
  await runtime.retireWorkers(job.scopeId, job.id);
  resolvedArtifact = { artifactDigest: "newer-artifact", provisionalRevision: "newer-revision" };
  await coordinator.artifactReady(input);

  assert.deepEqual([...delivered], ["artifact-replay-retired:auditor-grant:auditor-run"]);
});

test("audit outcomes derive issuer provenance from the authorized runtime binding", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-authority",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "authorized-auditor-run",
    producerPrincipalId: "producer-principal",
    auditorPrincipalId: "authorized-auditor-principal",
  });
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("unexpected dispatch");
      },
    },
    ...coreRuntimeAuthority(),
  });
  const supplied = {
    sessionId: "auditor-session",
    runId: "authorized-auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding" as const,
    generation: 1,
    evidenceFileId: "evidence-sha256",
    issuerPrincipalId: "model-supplied-principal",
    issuerRunId: "model-supplied-run",
    idempotencyKey: "pass-authority",
  };

  await coordinator.auditPassed(supplied);

  const event = (await jobs.listEvents(job.scopeId, job.id)).find((item) => item.type === "audit_passed");
  assert.equal(event?.payload.issuerPrincipalId, "authorized-auditor-principal");
  assert.equal(event?.payload.issuerRunId, "authorized-auditor-run");
});

test("BLOCK retry reuses verified evidence after policy advances before dispatch", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-replay-block",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  let evidenceResolutions = 0;
  let dispatches = 0;
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        dispatches += 1;
        if (dispatches === 1) throw new Error("producer dispatch crashed");
      },
    },
    artifactBinding: coreRuntimeAuthority().artifactBinding,
    workerPolicy: coreRuntimeAuthority().workerPolicy,
    evidenceAuthority: {
      async resolve(input) {
        evidenceResolutions += 1;
        if (input.job.policy.requiredGenerations[input.checkId] !== input.generation) {
          throw new Error("deterministic envelope generation advanced");
        }
        return {
          evidenceDigest: "verified-envelope-digest",
          ...testDeterministicAuthority(input.checkId, input.verdict, input.job.policy.evaluator),
        };
      },
    },
    escalationDecision: {
      async decide() {
        return { kind: "rework" as const };
      },
    },
  });
  const input = {
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "formula.recalculate" as const,
    generation: 1,
    evidenceFileId: "deterministic-envelope-file",
    findings: [{ code: "FORMULA", message: "Formula failed" }],
    idempotencyKey: "block-crash-replay",
  };
  await assert.rejects(coordinator.auditBlocked(input), /dispatch crashed/i);
  await coordinator.auditBlocked(input);
  assert.equal(evidenceResolutions, 1);
  assert.equal(dispatches, 2);
});
test("artifact dispatch recovers from committed action authority without resolving the original proposal", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const wakes: string[] = [];
  const first = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("dispatch interrupted");
      },
    },
    recoveryWake(recovery) {
      wakes.push(recovery.idempotencyKey);
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-crash-window",
  };
  await assert.rejects(first.artifactReady(input), /dispatch interrupted/);
  assert.deepEqual(wakes, ["artifact-crash-window"]);
  const pending = await runtime.pendingRecoveries();
  assert.deepEqual(pending, [{ kind: "artifact_ready", ...input }]);
  const delivered: string[] = [];
  const restarted = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        delivered.push(message.idempotencyKey);
      },
    },
    artifactBinding: {
      async resolve() {
        throw new Error("proposal must not be retried");
      },
    },
    workerPolicy: coreRuntimeAuthority().workerPolicy,
    evidenceAuthority: coreRuntimeAuthority().evidenceAuthority,
  });
  await restarted.artifactReady(pending[0]!);
  assert.deepEqual(delivered, ["artifact-crash-window:auditor-grant:auditor-run"]);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
});

test("producer rework dispatch recovers from the committed BLOCK without repeating escalation judgment", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-block-crash",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const wakes: string[] = [];
  let acceptedMessage = "";
  const first = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        acceptedMessage = message.message;
        throw new Error("rework dispatch interrupted");
      },
    },
    escalationDecision: {
      async decide() {
        return { kind: "rework" as const };
      },
    },
    recoveryWake(recovery) {
      wakes.push(recovery.idempotencyKey);
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding" as const,
    generation: 1,
    evidenceFileId: "evidence-block-crash",
    findings: [{ message: "Repair source lineage", code: "LINEAGE" }],
    idempotencyKey: "block-crash-window",
  };
  await assert.rejects(first.auditBlocked(input), /rework dispatch interrupted/);
  assert.deepEqual(wakes, ["block-crash-window"]);
  const pending = await runtime.pendingRecoveries();
  assert.deepEqual(pending, [{ kind: "audit_blocked", ...input }]);
  const delivered: string[] = [];
  const restarted = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        assert.equal(message.message, acceptedMessage);
        delivered.push(message.idempotencyKey);
      },
    },
    escalationDecision: {
      async decide() {
        throw new Error("judgment must not be retried");
      },
    },
    ...coreRuntimeAuthority(),
  });
  await restarted.auditBlocked(pending[0]!);
  assert.deepEqual(delivered, ["block-crash-window:producer-rework"]);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
});

test("runtime reconciliation records a poison recovery and continues with later jobs", async () => {
  const recoveries = [
    {
      kind: "artifact_ready" as const,
      sessionId: "poison-session",
      runId: "poison-run",
      scopeId: "personal:U1",
      jobId: "poison-job",
      idempotencyKey: "poison-artifact",
    },
    {
      kind: "artifact_ready" as const,
      sessionId: "healthy-session",
      runId: "healthy-run",
      scopeId: "personal:U1",
      jobId: "healthy-job",
      idempotencyKey: "healthy-artifact",
    },
  ];
  const attempted: string[] = [];
  const errors: Array<{ error: unknown; recovery: FinnyRuntimeRecovery }> = [];
  await reconcileFinnyRuntimeRecoveries({
    recoveries: async () => recoveries,
    coordinatorFor: async (_scopeId, jobId) => ({
      async artifactReady() {
        attempted.push(jobId);
        if (jobId === "poison-job") throw new Error("poison recovery");
      },
      async auditPassed() {
        throw new Error("unexpected PASS recovery");
      },
      async auditBlocked() {
        throw new Error("unexpected BLOCK recovery");
      },
      async verificationReopened() {
        throw new Error("unexpected reverification recovery");
      },
    }),
    recordError: async (error, recovery) => {
      errors.push({ error, recovery });
    },
  });
  assert.deepEqual(attempted, ["poison-job", "healthy-job"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.error), /poison recovery/);
  assert.equal(errors[0]?.recovery.idempotencyKey, "poison-artifact");
});

test("restart replays artifact authority committed before the job event", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  await createPgPool(connectionString).q(
    "UPDATE finny_runtime_bindings SET expires_at=$2 WHERE session_id=$1 AND role='auditor'",
    ["auditor-session", Date.now() - 1],
  );
  const input = {
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-authorized-only",
  };
  await runtime.authorizeAction({
    ...input,
    kind: "artifact_ready",
    role: "producer",
    requestDigest: runtimeDigest({}),
    authorityPayload: { artifactDigest: "artifact-sha256", provisionalRevision: "revision-1" },
  });
  assert.deepEqual(await runtime.pendingRecoveries(), [{ kind: "artifact_ready", ...input }]);
  const delivered: string[] = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        return { ok: true as const, sessionId: "auditor-session", runId: "auditor-run", title: "Finny Auditor" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        delivered.push(message.idempotencyKey);
      },
    },
    artifactBinding: {
      async resolve() {
        throw new Error("proposal must not be retried");
      },
    },
    workerPolicy: coreRuntimeAuthority().workerPolicy,
    evidenceAuthority: coreRuntimeAuthority().evidenceAuthority,
  });
  await coordinator.artifactReady(input);
  assert.deepEqual(delivered, ["artifact-authorized-only:auditor-grant:auditor-run"]);
});

test("restart replays BLOCK authority committed before the job event", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-authorized-block",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const input = {
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding" as const,
    generation: 1,
    evidenceFileId: "evidence-authorized-only",
    findings: [{ code: "LINEAGE", message: "Repair lineage" }],
    idempotencyKey: "block-authorized-only",
  };
  const recovery = {
    artifactDigest: input.artifactDigest,
    checkId: input.checkId,
    generation: input.generation,
    evidenceFileId: input.evidenceFileId,
    findings: input.findings,
  };
  await runtime.authorizeAction({
    ...input,
    kind: "audit_blocked",
    role: "auditor",
    requestDigest: runtimeDigest(recovery),
    authorityPayload: { resolution: { kind: "rework" }, evidenceDigest: "verified-block-digest", recovery },
  });
  assert.deepEqual(await runtime.pendingRecoveries(), [{ kind: "audit_blocked", ...input }]);
  const delivered: string[] = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        delivered.push(message.idempotencyKey);
      },
    },
    escalationDecision: {
      async decide() {
        throw new Error("judgment must not be retried");
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.auditBlocked(input);
  assert.deepEqual(delivered, ["block-authorized-only:producer-rework"]);
});

test("restart replays PASS authority committed before the job event", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-authorized-pass",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const input = {
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding" as const,
    generation: 1,
    evidenceFileId: "evidence-pass-authorized-only",
    idempotencyKey: "pass-authorized-only",
  };
  const recovery = {
    artifactDigest: input.artifactDigest,
    checkId: input.checkId,
    generation: input.generation,
    evidenceFileId: input.evidenceFileId,
  };
  await runtime.authorizeAction({
    ...input,
    kind: "audit_passed",
    role: "auditor",
    requestDigest: runtimeDigest(recovery),
    authorityPayload: { evidenceDigest: "verified-pass-digest", recovery },
  });
  assert.deepEqual(await runtime.pendingRecoveries(), [{ kind: "audit_passed", ...input }]);
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("unexpected dispatch");
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.auditPassed(input);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
  assert.equal((await jobs.listEvents(job.scopeId, job.id)).at(-1)?.type, "audit_passed");
});

test("restart replays escalation authority committed before the BLOCK event", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-authorized-escalation",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const input = {
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "lineage.binding" as const,
    generation: 1,
    evidenceFileId: "evidence-escalation-authorized-only",
    findings: [{ code: "LINEAGE", message: "Escalate lineage" }],
    idempotencyKey: "escalation-authorized-only",
  };
  const recovery = {
    artifactDigest: input.artifactDigest,
    checkId: input.checkId,
    generation: input.generation,
    evidenceFileId: input.evidenceFileId,
    findings: input.findings,
  };
  await runtime.authorizeAction({
    ...input,
    kind: "audit_blocked",
    role: "auditor",
    requestDigest: runtimeDigest(recovery),
    authorityPayload: {
      resolution: { kind: "escalate", reason: "Human review required" },
      evidenceDigest: "verified-escalation-digest",
      recovery,
    },
  });
  assert.deepEqual(await runtime.pendingRecoveries(), [{ kind: "audit_blocked", ...input }]);
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("unexpected dispatch");
      },
    },
    escalationDecision: {
      async decide() {
        throw new Error("judgment must not be retried");
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.auditBlocked(input);
  assert.ok((await jobs.getJob(job.scopeId, job.id))?.unresolvedEscalationSequence);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
});

test("evaluator correction dispatches Auditor-only reverification for the unchanged artifact", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-evaluator-correction",
  });
  await jobs.recordAuditBlock({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "summary.crossfoot",
    generation: 1,
    evidenceDigest: "old-evaluator-evidence",
    issuerPrincipalId: "auditor-principal",
    issuerRunId: "auditor-run",
    ...testDeterministicAuthority("summary.crossfoot", "block", job.policy.evaluator),
    findings: [{ code: "CROSSFOOT_MISMATCH", message: "Old evaluator rejected a supported term" }],
    changeKinds: ["formula"],
    resolution: { kind: "rework" },
    idempotencyKey: "old-evaluator-block",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r2",
    buildDigest: "2".repeat(64),
    configurationDigest: "3".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "evaluator-correction-r2",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  assert.deepEqual(await runtime.pendingRecoveries(), [
    {
      kind: "verification_reopened",
      scopeId: job.scopeId,
      jobId: job.id,
      idempotencyKey: "evaluator-correction-r2",
    },
  ]);
  const delivered: Array<{ idempotencyKey: string; role: string }> = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("existing Auditor binding should be reused");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        delivered.push({ idempotencyKey: message.idempotencyKey, role: message.role });
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.verificationReopened({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "evaluator-correction-r2",
  });
  assert.deepEqual(delivered, [
    { idempotencyKey: "evaluator-correction-r2:auditor-reverify:auditor-run", role: "auditor" },
  ]);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
  const corrected = await jobs.getJob(job.scopeId, job.id);
  assert.equal(corrected?.artifactDigest, "artifact-sha256");
  assert.equal(corrected?.provisionalRevision, "revision-1");
});

test("evaluator correction cancels an authorized stale BLOCK before Producer dispatch", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-cancelled-block",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const input = {
    sessionId: "auditor-session",
    runId: "auditor-run",
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    checkId: "summary.crossfoot" as const,
    generation: 1,
    evidenceFileId: "old-evaluator-evidence-file",
    findings: [{ code: "CROSSFOOT_MISMATCH", message: "Old evaluator mismatch" }],
    idempotencyKey: "authorized-stale-block",
  };
  const recovery = {
    artifactDigest: input.artifactDigest,
    checkId: input.checkId,
    generation: input.generation,
    evidenceFileId: input.evidenceFileId,
    findings: input.findings,
  };
  const deterministicAuthority = testDeterministicAuthority(
    input.checkId,
    "block",
    TEST_FINNY_EVALUATOR,
  ).deterministicAuthority!;
  await runtime.authorizeAction({
    ...input,
    kind: "audit_blocked",
    role: "auditor",
    requestDigest: runtimeDigest(recovery),
    authorityPayload: {
      resolution: { kind: "rework" },
      evidenceAuthority: { evidenceDigest: "old-evaluator-envelope", deterministicAuthority },
      recovery,
    },
  });
  const blocked = await jobs.recordAuditBlock({
    scopeId: input.scopeId,
    jobId: input.jobId,
    artifactDigest: input.artifactDigest,
    checkId: input.checkId,
    generation: input.generation,
    evidenceDigest: "old-evaluator-envelope",
    deterministicAuthority,
    issuerPrincipalId: "U1",
    issuerRunId: input.runId,
    findings: input.findings,
    changeKinds: ["formula"],
    resolution: { kind: "rework" },
    idempotencyKey: input.idempotencyKey,
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r3",
    buildDigest: "4".repeat(64),
    configurationDigest: "5".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: blocked.job.policy.evaluator,
    toEvaluator: evaluator,
    idempotencyKey: "cancel-stale-block-with-r3",
  });
  assert.equal(
    (await runtime.pendingRecoveries()).some((item) => item.kind === "audit_blocked"),
    false,
  );
  let producerDispatches = 0;
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        if (message.role === "producer") producerDispatches += 1;
      },
    },
    escalationDecision: {
      async decide() {
        throw new Error("committed resolution must be reused");
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.auditBlocked(input);
  assert.equal(producerDispatches, 0);
});

test("expired delivered reverification grants return to recovery", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-expired-reverify",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r4",
    buildDigest: "6".repeat(64),
    configurationDigest: "7".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "expired-reverify-r4",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("existing Auditor binding should be used");
      },
    },
    dispatcher: { async dispatchPrivateIdempotent() {} },
    ...coreRuntimeAuthority(),
  });
  await coordinator.verificationReopened({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "expired-reverify-r4",
  });
  const { q } = createPgPool(connectionString);
  await q("UPDATE finny_runtime_bindings SET expires_at=$2 WHERE run_id=$1", ["auditor-run", Date.now() - 1]);
  assert.equal(
    (await runtime.pendingRecoveries()).some(
      (item) => item.kind === "verification_reopened" && item.idempotencyKey === "expired-reverify-r4",
    ),
    true,
  );
});

test("orphaned delivered reverification opens a replacement Auditor", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const { q } = createPgPool(connectionString);
  await q(`CREATE TABLE runs(
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_stop TEXT,
    result TEXT
  )`);
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-orphaned-reverify",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r5",
    buildDigest: "8".repeat(64),
    configurationDigest: "9".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "orphaned-reverify-r5",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "orphaned-auditor-session",
    auditorRunId: "orphaned-auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const initialCoordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("existing binding should be used initially");
      },
    },
    dispatcher: { async dispatchPrivateIdempotent() {} },
    ...coreRuntimeAuthority(),
  });
  await initialCoordinator.verificationReopened({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "orphaned-reverify-r5",
  });
  const recovery = (await runtime.pendingRecoveries()).find(
    (item) => item.kind === "verification_reopened" && item.idempotencyKey === "orphaned-reverify-r5",
  );
  assert.deepEqual(recovery, {
    kind: "verification_reopened",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "orphaned-reverify-r5",
    forceNewAuditor: true,
  });
  let openedAuditors = 0;
  const replacementCoordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        openedAuditors += 1;
        return {
          ok: true as const,
          sessionId: "replacement-auditor-session",
          runId: "replacement-auditor-run",
          title: "Finny Auditor",
        };
      },
    },
    dispatcher: { async dispatchPrivateIdempotent() {} },
    ...coreRuntimeAuthority(),
  });
  await replacementCoordinator.verificationReopened(recovery!);
  assert.equal(openedAuditors, 1);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"))?.runId, "replacement-auditor-run");
});

test("terminal delivered reverification opens a replacement Auditor", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const { q } = createPgPool(connectionString);
  await q(`CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,last_stop TEXT,result TEXT)`);
  await q("INSERT INTO runs(id,status,last_stop,result) VALUES($1,'done','terminal',NULL)", ["terminal-auditor-run"]);
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-terminal-reverify",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r6",
    buildDigest: "a".repeat(64),
    configurationDigest: "b".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "terminal-reverify-r6",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "terminal-auditor-session",
    auditorRunId: "terminal-auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const initial = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("initial binding should be reused");
      },
    },
    dispatcher: { async dispatchPrivateIdempotent() {} },
    ...coreRuntimeAuthority(),
  });
  await initial.verificationReopened({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "terminal-reverify-r6",
  });
  const recovery = (await runtime.pendingRecoveries()).find(
    (item) => item.kind === "verification_reopened" && item.idempotencyKey === "terminal-reverify-r6",
  );
  assert.equal(recovery?.kind === "verification_reopened" && recovery.forceNewAuditor, true);
  const replacement = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        return {
          ok: true as const,
          sessionId: "terminal-replacement-session",
          runId: "terminal-replacement-run",
          title: "Finny Auditor",
        };
      },
    },
    dispatcher: { async dispatchPrivateIdempotent() {} },
    ...coreRuntimeAuthority(),
  });
  await replacement.verificationReopened(recovery!);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"))?.runId, "terminal-replacement-run");
});
