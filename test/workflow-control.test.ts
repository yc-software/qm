import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createWorkflowControl, workflowDefinitionsForSession } from "../src/sessions/workflow-control.ts";
import { scopeId } from "../src/types.ts";

test("workflow control derives the producer identity from the host session", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-control");
  const session = await sessions.getOrCreateByThread("control", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async (ids) => ids.map((id) => ({ id, digest: `host:${id}` })),
    definitions: [
      {
        id: "finance",
        version: 1,
        steps: [{ id: "request-bound", role: "producer", requiredSkills: [] }],
      },
    ],
  });

  const result = await control({
    action: "advance",
    workflowId: "finance",
    step: "request-bound",
    decision: "pass",
  });

  assert.deepEqual(result, {
    accepted: true,
    workflowId: "finance",
    workflowVersion: 1,
    step: "request-bound",
    role: "producer",
    decision: "pass",
    subject: session.id,
    observedSkills: [],
    missingSkills: [],
    unexpectedSkills: [],
    blockers: [],
    findings: [],
    inputEvidence: [],
    outputEvidence: [],
  });
  const retry = await control({
    action: "advance",
    workflowId: "finance",
    step: "request-bound",
    decision: "pass",
  });
  assert.equal((retry as { accepted: boolean }).accepted, false);
  assert.deepEqual(await control({ action: "status", workflowId: "finance" }), {
    jobId: session.id,
    workflowId: "finance",
    workflowVersion: 1,
    current: { state: "complete" },
    steps: [
      {
        step: "request-bound",
        role: "producer",
        state: "passed",
        decision: "pass",
        subject: session.id,
        findings: [],
      },
    ],
  });
  await assert.rejects(
    control({ action: "advance", workflowId: "unknown", step: "request-bound", decision: "pass" }),
    /workflow unknown is not registered/,
  );
});

test("a human approval step cannot be advanced through the ordinary producer action", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-approval");
  const session = await sessions.getOrCreateByThread("approval", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async (ids) => ids.map((id) => ({ id, digest: `host:${id}` })),
    definitions: [
      {
        id: "approval",
        version: 1,
        steps: [{ id: "PLAN_APPROVED", role: "producer", humanApproval: true, requiredSkills: [] }],
      },
    ],
  });

  await assert.rejects(
    control({
      action: "advance",
      workflowId: "approval",
      step: "PLAN_APPROVED",
      decision: "pass",
    }),
    /requires the approval action/,
  );
});

test("a human approval durably carries forward exactly the evidence it approved", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-approval-evidence");
  const session = await sessions.getOrCreateByThread("approval-evidence", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "ultimate", modelId: "gpt-6.1-sol" }),
    resolveEvidence: async (ids) => ids.map((id) => ({ id, digest: `host:${id}` })),
    definitions: [
      {
        id: "approval",
        version: 1,
        steps: [{ id: "PLAN_APPROVED", role: "producer", humanApproval: true, requiredSkills: [] }],
      },
    ],
  });

  const result = await control({
    action: "approve",
    workflowId: "approval",
    step: "PLAN_APPROVED",
    decision: "pass",
    inputEvidence: [{ id: "source-plan" }],
  });

  assert.deepEqual((result as { inputEvidence: unknown }).inputEvidence, [
    { id: "source-plan", digest: "host:source-plan" },
  ]);
  assert.deepEqual((result as { outputEvidence: unknown }).outputEvidence, [
    { id: "source-plan", digest: "host:source-plan" },
  ]);
});

test("a human approval rejects output evidence that differs from its approved input", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-approval-mismatch");
  const session = await sessions.getOrCreateByThread("approval-mismatch", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "ultimate", modelId: "gpt-6.1-sol" }),
    resolveEvidence: async (ids) => ids.map((id) => ({ id, digest: `host:${id}` })),
    definitions: [
      {
        id: "approval",
        version: 1,
        steps: [{ id: "PLAN_APPROVED", role: "producer", humanApproval: true, requiredSkills: [] }],
      },
    ],
  });

  await assert.rejects(
    control({
      action: "approve",
      workflowId: "approval",
      step: "PLAN_APPROVED",
      decision: "pass",
      inputEvidence: [{ id: "source-plan" }],
      outputEvidence: [{ id: "other-plan" }],
    }),
    /approval output evidence must match its approved input evidence/,
  );
});

test("a human approval cannot import an isolated reviewer receipt", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-approval-reviewer");
  const session = await sessions.getOrCreateByThread("approval-reviewer", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "ultimate", modelId: "gpt-6.1-sol" }),
    resolveEvidence: async (ids) => ids.map((id) => ({ id, digest: `host:${id}` })),
    definitions: [
      {
        id: "approval",
        version: 1,
        steps: [
          {
            id: "PLAN_APPROVED",
            role: "producer",
            humanApproval: true,
            separateFrom: "PLAN_APPROVED",
            requiredSkills: [],
          },
        ],
      },
    ],
  });

  await assert.rejects(
    control({
      action: "approve",
      workflowId: "approval",
      step: "PLAN_APPROVED",
      reviewerSessionId: "reviewer",
      inputEvidence: [{ id: "source-plan" }],
    }),
    /human approval cannot import a reviewer receipt/,
  );
});

test("workflow status reports a valid rejection without marking an invalid attempt rejected", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-rejection");
  const session = await sessions.getOrCreateByThread("rejection", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async () => [],
    definitions: [
      {
        id: "rejection",
        version: 1,
        steps: [{ id: "review", role: "reviewer", requiredSkills: [] }],
      },
    ],
  });
  await control({
    action: "advance",
    workflowId: "rejection",
    step: "review",
    decision: "reject",
    findings: ["source evidence is incomplete"],
  });
  assert.deepEqual(await control({ action: "status", workflowId: "rejection" }), {
    jobId: session.id,
    workflowId: "rejection",
    workflowVersion: 1,
    current: { step: "review", role: "reviewer", state: "rejected" },
    steps: [
      {
        step: "review",
        role: "reviewer",
        state: "rejected",
        decision: "reject",
        subject: session.id,
        findings: ["source evidence is incomplete"],
      },
    ],
  });
});

test("the producer cannot directly advance a separated review stage", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-review-owner");
  const session = await sessions.getOrCreateByThread("review-owner", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async () => [],
    definitions: [
      {
        id: "review-owner",
        version: 1,
        steps: [
          { id: "raw", role: "producer", requiredSkills: [] },
          { id: "audit", role: "auditor", after: "raw", separateFrom: "raw", requiredSkills: [] },
        ],
      },
    ],
  });
  await assert.rejects(
    control({ action: "advance", workflowId: "review-owner", step: "audit", decision: "pass" }),
    /reviewer receipt/,
  );
});

test("workflow control replaces model evidence claims with durable artifact digests", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-evidence");
  const session = await sessions.getOrCreateByThread("evidence", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async (ids) => {
      if (ids.includes("unknown")) throw new Error("workflow evidence unknown is not an accessible durable artifact");
      return ids.map((id) => ({ id, digest: `host:${id}` }));
    },
    definitions: [
      {
        id: "evidence",
        version: 1,
        steps: [{ id: "RAW_EVIDENCE_READY", role: "producer", requiredSkills: [] }],
      },
    ],
  });

  const result = await control({
    action: "advance",
    workflowId: "evidence",
    step: "RAW_EVIDENCE_READY",
    decision: "pass",
    outputEvidence: [{ id: "raw-workbook" }],
  });
  assert.deepEqual((result as { outputEvidence: unknown }).outputEvidence, [
    { id: "raw-workbook", digest: "host:raw-workbook" },
  ]);
  await assert.rejects(
    control({
      action: "advance",
      workflowId: "evidence",
      step: "RAW_EVIDENCE_READY",
      decision: "pass",
      outputEvidence: [{ id: "unknown" }],
    }),
    /not an accessible durable artifact/,
  );
});

test("an in-flight workflow keeps its durable definition across deployment changes", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-snapshot");
  const session = await sessions.getOrCreateByThread("snapshot", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const original = {
    id: "finance",
    version: 1,
    steps: [{ id: "request-bound", role: "producer", requiredSkills: [] }],
  } as const;
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async () => [],
    definitions: [original],
  });
  await control({ action: "advance", workflowId: "finance", step: "request-bound", decision: "pass" });

  assert.deepEqual(
    await workflowDefinitionsForSession({
      sessions,
      sessionId: session.id,
      configured: [
        {
          id: "finance",
          version: 1,
          steps: [{ id: "changed", role: "producer", requiredSkills: [] }],
        },
      ],
    }),
    [original],
  );
  assert.deepEqual(await workflowDefinitionsForSession({ sessions, sessionId: session.id, configured: [] }), [
    original,
  ]);
});
