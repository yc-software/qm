import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createFinnyRuntimeCoordinator } from "../src/finny/runtime-coordinator.ts";
import { createPostgresFinnyRuntimeStore } from "../src/finny/runtime-postgres-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
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
    policy: initialFinnyPolicy(),
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

test("opens producer and Auditor concurrently and dispatches only the producer grant after approval", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const grants = createFinnyWorkerGrants(jobs, "runtime-test-secret");
  const opened: string[] = [];
  const openTasks: string[] = [];
  let waiting = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sessions = {
    async open(input: { name?: string; task: string }) {
      opened.push(input.name ?? "");
      openTasks.push(input.task);
      waiting += 1;
      if (waiting === 2) release?.();
      await barrier;
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
  assert.deepEqual(opened.sort(), ["Finny Auditor", "Finny Producer"]);
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
    evidenceDigest: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Source lineage is incomplete" }],
    changeKinds: ["lineage"],
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
    evidenceDigest: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Repair lineage" }],
    changeKinds: ["lineage"],
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
  assert.match(dispatched[0] ?? "", /^finny:.*:producer-grant$/);
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
    evidenceDigest: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Cannot establish lineage" }],
    changeKinds: ["lineage"],
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
      evidenceDigest: "evidence-sha256",
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
    evidenceDigest: "evidence-sha256-block",
    findings: [{ code: "LINEAGE", message: "Repair lineage" }],
    changeKinds: ["lineage" as const],
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
  assert.match([...delivered][0] ?? "", /^finny:.*:producer-grant$/);
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

  assert.deepEqual([...delivered], ["artifact-replay-retired:auditor-grant"]);
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
    evidenceDigest: "evidence-sha256",
    issuerPrincipalId: "model-supplied-principal",
    issuerRunId: "model-supplied-run",
    idempotencyKey: "pass-authority",
  };

  await coordinator.auditPassed(supplied);

  const event = (await jobs.listEvents(job.scopeId, job.id)).find((item) => item.type === "audit_passed");
  assert.equal(event?.payload.issuerPrincipalId, "authorized-auditor-principal");
  assert.equal(event?.payload.issuerRunId, "authorized-auditor-run");
});
