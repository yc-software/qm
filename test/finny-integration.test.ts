import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinnyToolServiceFactory, finnySlackAuthority } from "../src/finny/integration.ts";
import { channelThreadRef, dmThreadRef } from "../src/slack/message-gating.ts";
import type { FinnyJob, FinnyPlanPresentation } from "../src/finny/types.ts";

const plan: FinnyPlanPresentation = {
  title: "Close",
  phases: [{ name: "Prepare", owner: "Producer", dependencies: [] }],
  certification: "Independent audit",
  deliverable: "Workbook",
  destination: "Origin thread",
  clarifications: [],
};

function harness(binding: { role: "parent" | "producer" | "auditor" } | null = null) {
  const calls: Array<[string, unknown]> = [];
  const job = {
    id: "job-1",
    scopeId: "scope-1",
    plan,
    policy: { policyVersion: "v1", requiredGenerations: {} },
  } as FinnyJob;
  const factory = createFinnyToolServiceFactory({
    config: {
      findingPolicy: { id: "bounds.v1", maxFindings: 4, maxCodeLength: 20, maxMessageLength: 200 },
      maxReworks: 2,
      workerGrantTtlMs: 1000,
    },
    jobs: {
      async createJob(input: any) {
        calls.push(["createJob", input]);
        return { ...job, id: input.id };
      },
      async getJob(scopeId: string, jobId: string) {
        return scopeId === "scope-1" && jobId === "job-1" ? job : null;
      },
    },
    runtime: {
      async currentBinding() {
        return binding
          ? {
              ...binding,
              scopeId: "scope-1",
              jobId: "job-1",
              sessionId: "session-1",
              runId: "run-1",
              active: true,
              principalId: "actor-1",
              epoch: 1,
            }
          : null;
      },
      async claimParentTurn() {
        return binding
          ? {
              ...binding,
              scopeId: "scope-1",
              jobId: "job-1",
              sessionId: "session-1",
              runId: "run-1",
              active: true,
              principalId: "actor-1",
              epoch: 1,
            }
          : null;
      },
    },
    integration: {
      async createPlanIntent(input: any) {
        calls.push(["createPlanIntent", input]);
      },
      async completePlanIntent(input: any) {
        calls.push(["createApprovalBoundParent", input]);
      },
      async createApprovalBoundParent(input: any) {
        calls.push(["createApprovalBoundParent", input]);
      },
      async saveArtifactProposal(input: any) {
        calls.push(["saveArtifactProposal", input]);
      },
    },
    deliveries: {
      async enqueue(input: any) {
        calls.push(["enqueue", input]);
        return input;
      },
    },
    coordinator: {
      async artifactReady(input: any) {
        calls.push(["artifactReady", input]);
      },
      async auditPassed(input: any) {
        calls.push(["auditPassed", input]);
      },
      async auditBlocked(input: any) {
        calls.push(["auditBlocked", input]);
      },
    },
    finalizer: {
      async finalize(input: any) {
        calls.push(["finalize", input]);
        return { token: "receipt", payload: { artifactDigest: "digest", provisionalRevision: "r1" } };
      },
    },
    async deliverFinal(input: any) {
      calls.push(["deliverFinal", input]);
    },
    ids: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  } as any);
  return { factory, calls };
}

const parent = {
  actor: { id: "actor-1", type: "internal" as const },
  scopeId: "scope-1",
  sessionId: "session-1",
  runId: "run-1",
  originThreadRef: "slack:C1:100.1",
  destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
  parent: true,
  parentBinding: {
    schema: "finny-parent-binding.v1" as const,
    sessionId: "session-1",
    runId: "run-1",
    scopeId: "scope-1",
    context: {
      actor: { id: "actor-1", type: "internal" as const },
      conversation: {
        kind: "dm" as const,
        threadRef: "slack:C1:100.1",
        audience: [{ id: "actor-1", type: "internal" as const }],
      },
      surface: "slack",
    },
  },
};

test("parent create_plan persists server authority before idempotent native plan delivery", async () => {
  const { factory, calls } = harness();
  const service = await factory.forTurn(parent);
  assert.ok(service);
  assert.equal(await service.createPlan(plan), "Finny plan id-1 is awaiting approval.");
  const created: any = calls.find(([name]) => name === "createJob")?.[1];
  assert.equal(created.scopeId, "scope-1");
  assert.equal(created.originThreadRef, parent.originThreadRef);
  assert.equal(created.findingPolicy.id, "bounds.v1");
  const approval: any = calls.find(([name]) => name === "createApprovalBoundParent")?.[1];
  assert.equal(approval.actorId, "actor-1");
  const delivery: any = calls.find(([name]) => name === "enqueue")?.[1];
  assert.equal(delivery.destination.finnyPlanRequestId, "id-2");
  assert.equal(delivery.idempotencyKey, "finny-plan:id-2");
});

test("worker service derives job authority from exact current session and run", async () => {
  const { factory, calls } = harness({ role: "producer" });
  const service = await factory.forTurn(parent);
  assert.ok(service);
  await service.artifactReady({ artifactDigest: "digest", provisionalRevision: "r1", idempotencyKey: "ready-1" });
  assert.deepEqual(
    calls.filter(([name]) => name === "saveArtifactProposal").map(([, value]) => value),
    [
      {
        scopeId: "scope-1",
        jobId: "job-1",
        sessionId: "session-1",
        runId: "run-1",
        artifactDigest: "digest",
        provisionalRevision: "r1",
        idempotencyKey: "ready-1",
      },
    ],
  );
  const artifactReady = calls.find(([name]) => name === "artifactReady")?.[1] as { jobId?: string } | undefined;
  assert.equal(artifactReady?.jobId, "job-1");
  await assert.rejects(
    () => service.pass({ checkId: "artifact.integrity", generation: 1, evidenceDigest: "e", idempotencyKey: "p" }),
    /Auditor/,
  );
});

test("forged worker session or run receives no Finny service", async () => {
  const { factory } = harness({ role: "auditor" });
  assert.equal(await factory.forTurn({ ...parent, runId: "forged", parent: false }), undefined);
  assert.equal(await factory.forTurn({ ...parent, sessionId: "forged", parent: false }), undefined);
});

test("configured max reworks escalates after the authoritative rework limit", async () => {
  const { createFinnyEscalationDecision } = await import("../src/finny/integration.ts");
  const events: any[] = [{ type: "rework_requested" }, { type: "rework_requested" }];
  const decision = createFinnyEscalationDecision({
    jobs: {
      async listEvents() {
        return events;
      },
    },
    maxReworks: 2,
  });
  assert.deepEqual(await decision.decide({ scopeId: "s", jobId: "j" }), {
    kind: "escalate",
    reason: "Finny reached the configured 2 BLOCK limit",
  });
  events.pop();
  assert.deepEqual(await decision.decide({ scopeId: "s", jobId: "j" }), { kind: "rework" });
});

test("Slack parent service fails closed when destination does not match the origin thread", async () => {
  const { factory } = harness();
  assert.equal(
    await factory.forTurn({ ...parent, destination: { type: "slack", target: "C2:100.1", threadTs: "100.1" } }),
    undefined,
  );
});

test("final delivery remains in the exact bound Slack thread with revision and signed receipt", async () => {
  const { finnyFinalDelivery } = await import("../src/finny/integration.ts");
  const job = {
    id: "job-1",
    originThreadRef: "slack:C1:100.1",
    plan: { ...plan, title: "Pack", certification: "Certified" },
  } as FinnyJob;
  const delivery = finnyFinalDelivery(
    { originThreadRef: job.originThreadRef, destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" } },
    job,
    { token: "signed-receipt", payload: { artifactDigest: "digest", provisionalRevision: "r7", ledgerHead: 9 } } as any,
  );
  assert.deepEqual(delivery.destination, { type: "slack", target: "C1:100.1", threadTs: "100.1" });
  assert.match(delivery.text, /signed-receipt/);
  assert.match(delivery.text, /r7/);
  assert.equal(delivery.idempotencyKey, "finny-final:job-1:9");
  assert.throws(
    () =>
      finnyFinalDelivery(
        { originThreadRef: job.originThreadRef, destination: { type: "slack", target: "C2:100.1" } },
        job,
        { token: "x", payload: {} } as any,
      ),
    /does not match/,
  );
});

test("artifact binding resolves immutable bytes from Core file authority", async () => {
  const { resolveFinnyFileArtifactProposal } = await import("../src/finny/integration.ts");
  const proposal = {
    scopeId: "scope-1",
    jobId: "job-1",
    sessionId: "session-1",
    runId: "run-1",
    artifactDigest: "sha-1",
    provisionalRevision: "file-1",
    idempotencyKey: "ready-1",
  };
  const get = async () => ({ id: "file-1", ownerScopeId: "scope-1", sha256: "sha-1", enabled: true });
  assert.deepEqual(await resolveFinnyFileArtifactProposal({ get } as any, proposal), {
    artifactDigest: "sha-1",
    provisionalRevision: "file-1",
  });
  await assert.rejects(
    () =>
      resolveFinnyFileArtifactProposal({ get: async () => ({ ...(await get()), sha256: "other" }) } as any, proposal),
    /does not match/,
  );
});

test("real Slack channel and DM refs derive authority from the exact delivery target", () => {
  assert.equal(channelThreadRef("channel", "C1", "100.1"), "ch:C1:100.1");
  assert.equal(dmThreadRef("D1", "100.1"), "dm:D1:100.1");
  assert.deepEqual(finnySlackAuthority("slack", "C1:100.1", false), {
    originThreadRef: "slack:C1:100.1",
    destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
  });
  assert.deepEqual(finnySlackAuthority("slack", "D1", false, "200.2"), {
    originThreadRef: "slack:D1:200.2",
    destination: { type: "slack", target: "D1:200.2", threadTs: "200.2" },
  });
  assert.equal(finnySlackAuthority("slack", "D1", false), undefined);
  assert.equal(finnySlackAuthority("slack", "C1:100.1", true), undefined);
});
