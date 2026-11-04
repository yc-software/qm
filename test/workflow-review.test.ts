import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import {
  activeWorkflowReviewAssignment,
  assignedWorkflowReview,
  assignWorkflowReviewer,
  importWorkflowReview,
  recordWorkflowReview,
  workflowEvidenceForProducer,
  workflowEvidenceForReviewer,
  workflowReviewReady,
} from "../src/sessions/workflow-review.ts";
import { scopeId } from "../src/types.ts";

const scope = scopeId("personal", "finance-review");
const definition = {
  id: "finance-review",
  version: 1,
  steps: [
    { id: "raw-evidence-ready", role: "producer", requiredSkills: [] },
    {
      id: "auditor-1-pass",
      role: "evidence-auditor",
      after: "raw-evidence-ready",
      separateFrom: "raw-evidence-ready",
      evidenceFrom: "raw-evidence-ready",
      requiredSkills: [{ skillId: "finance-audit", contentDigest: "audit-digest" }],
    },
  ],
} as const;

test("a producer can read accepted evidence from its workflow lineage", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("producer-evidence-parent", "dm", scope);
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);
  const evidence = [{ id: "raw-evidence", digest: "d".repeat(64) }];
  await importWorkflowReview({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    definition,
    producerSubmission: { step: "raw-evidence-ready", decision: "pass", outputEvidence: evidence },
  });

  assert.deepEqual(
    await workflowEvidenceForProducer({ sessions, sessionId: parent.id, definitions: [definition] }),
    evidence,
  );
  assert.deepEqual(
    await workflowEvidenceForProducer({
      sessions,
      sessionId: parent.id,
      definitions: [{ ...definition, version: 2 }],
    }),
    [],
  );
});

test("an assigned reviewer can read the approved evidence lineage through its stage", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("evidence-parent", "dm", scope);
  const child = await sessions.getOrCreateByThread("evidence-child", "dm", scope);
  const unrelated = await sessions.getOrCreateByThread("evidence-unrelated", "dm", scope);
  await sessions.setParentSession(child.id, parent.id);
  await sessions.setParentSession(unrelated.id, parent.id);
  for (const reviewer of [child, unrelated])
    await sessions.setSpawnMeta(reviewer.id, {
      surface: "web",
      actor: { id: "reviewer", type: "internal" },
      conversation: { kind: "dm", threadRef: reviewer.threadRef, audience: [] },
      harness: "pi",
      model: "gpt-5.4",
      readOnly: true,
    });
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);
  const evidence = [{ id: "raw-evidence", digest: "d".repeat(64) }];
  await importWorkflowReview({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    definition,
    producerSubmission: { step: "raw-evidence-ready", decision: "pass", outputEvidence: evidence },
  });
  await assignWorkflowReviewer({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    reviewerSessionId: child.id,
    definition,
    step: "auditor-1-pass",
  });

  assert.deepEqual(
    await workflowEvidenceForReviewer({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definitions: [definition],
    }),
    evidence,
  );
  assert.deepEqual(
    await workflowEvidenceForReviewer({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: unrelated.id,
      definitions: [definition],
    }),
    [],
  );
});

test("an ordinary writable child cannot be assigned as a workflow reviewer", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("writable-parent", "dm", scope);
  const child = await sessions.getOrCreateByThread("writable-child", "dm", scope);
  await sessions.setParentSession(child.id, parent.id);
  await sessions.setSpawnMeta(child.id, {
    surface: "web",
    actor: { id: "reviewer", type: "internal" },
    conversation: { kind: "dm", threadRef: child.threadRef, audience: [] },
    harness: "pi",
    model: "gpt-5.4",
  });
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);
  await assert.rejects(
    assignWorkflowReviewer({
      sessions,
      lease: attempt.lease,
      scopeLabel: scope,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definition,
      step: "auditor-1-pass",
    }),
    /read-only/,
  );
});

test("a producer stage cannot be assigned to a child reviewer", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("producer-parent", "dm", scope);
  const child = await sessions.getOrCreateByThread("producer-child", "dm", scope);
  await sessions.setParentSession(child.id, parent.id);
  await sessions.setSpawnMeta(child.id, {
    surface: "web",
    actor: { id: "reviewer", type: "internal" },
    conversation: { kind: "dm", threadRef: child.threadRef, audience: [] },
    harness: "pi",
    model: "gpt-5.4",
    readOnly: true,
  });
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);
  await assert.rejects(
    assignWorkflowReviewer({
      sessions,
      lease: attempt.lease,
      scopeLabel: scope,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definition,
      step: "raw-evidence-ready",
    }),
    /review stage/,
  );
});

test("the parent imports the child reviewer receipt instead of a producer-supplied decision", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("parent", "dm", scope);
  const child = await sessions.getOrCreateByThread("child", "dm", scope);
  await sessions.setParentSession(child.id, parent.id);
  await sessions.setSpawnMeta(child.id, {
    surface: "web",
    actor: { id: "reviewer", type: "internal" },
    conversation: { kind: "dm", threadRef: child.threadRef, audience: [] },
    harness: "pi",
    model: "gpt-5.4",
    readOnly: true,
  });
  const parentAttempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(parentAttempt.lease);
  const parentLease = {
    ...parentAttempt.lease,
    turnId: "11111111-1111-4111-8111-111111111111",
  };
  const evidence = [{ id: "raw-workbook", digest: "sha256:current" }];
  const produced = await importWorkflowReview({
    sessions,
    lease: parentLease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    definition,
    producerSubmission: {
      step: "raw-evidence-ready",
      decision: "pass",
      outputEvidence: evidence,
    },
  });
  assert.equal(produced.accepted, true);
  const assignment = await assignWorkflowReviewer({
    sessions,
    lease: parentLease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    reviewerSessionId: child.id,
    definition,
    step: "auditor-1-pass",
  });
  assert.equal(
    await workflowReviewReady({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definition,
      step: "auditor-1-pass",
    }),
    false,
  );
  await sessions.releaseLease(parentLease);

  const childAttempt = await sessions.acquireLease(child.id, "turn");
  assert.ok(childAttempt.lease);
  const childLease = {
    ...childAttempt.lease,
    turnId: "22222222-2222-4222-8222-222222222222",
  };
  await sessions.appendMany(childLease, [
    {
      type: "tool_call",
      payload: { tool: "skills", callId: "audit-skill", action: "read", name: "finance-audit" },
      scopeLabel: scope,
    },
    {
      type: "tool_result",
      payload: {
        tool: "skills",
        callId: "audit-skill",
        action: "read",
        name: "finance-audit",
        found: true,
        provenance: { skillId: "finance-audit", skillVersion: 2, contentDigest: "audit-digest" },
      },
      scopeLabel: scope,
    },
  ]);
  const review = await recordWorkflowReview({
    sessions,
    lease: childLease,
    scopeLabel: scope,
    definition,
    runtime: { harnessId: "pi", modelId: "gpt-5.4" },
    assignment,
    submission: {
      step: "auditor-1-pass",
      decision: "reject",
      inputEvidence: evidence,
      findings: ["population incomplete"],
    },
  });
  assert.equal(review.valid, true);
  assert.equal(
    await workflowReviewReady({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definition,
      step: "auditor-1-pass",
    }),
    true,
  );
  await sessions.releaseLease(childLease);

  const importAttempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(importAttempt.lease);
  const imported = await importWorkflowReview({
    sessions,
    lease: {
      ...importAttempt.lease,
      turnId: "33333333-3333-4333-8333-333333333333",
    },
    scopeLabel: scope,
    parentSessionId: parent.id,
    definition,
    reviewerSessionId: child.id,
    reviewStep: "auditor-1-pass",
  });

  assert.equal(imported.decision, "reject");
  assert.equal(imported.accepted, false);
  assert.equal(imported.subject, child.id);
  assert.equal(
    await workflowReviewReady({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definition,
      step: "auditor-1-pass",
    }),
    false,
  );
  assert.deepEqual(imported.observedSkills, [
    { name: "finance-audit", skillId: "finance-audit", skillVersion: 2, contentDigest: "audit-digest" },
  ]);
  const reassignment = await assignWorkflowReviewer({
    sessions,
    lease: importAttempt.lease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    reviewerSessionId: child.id,
    definition,
    step: "auditor-1-pass",
  });
  assert.notEqual(reassignment.assignmentId, assignment.assignmentId);
  await assert.rejects(
    importWorkflowReview({
      sessions,
      lease: importAttempt.lease,
      scopeLabel: scope,
      parentSessionId: parent.id,
      definition,
      reviewerSessionId: child.id,
      reviewStep: "auditor-1-pass",
    }),
    /reviewer receipt does not match the durable assignment/,
  );
});

test("a reviewer receipt from a different host runtime cannot satisfy the assignment", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("runtime-parent", "dm", scope);
  const child = await sessions.getOrCreateByThread("runtime-child", "dm", scope);
  await sessions.setParentSession(child.id, parent.id);
  await sessions.setSpawnMeta(child.id, {
    surface: "web",
    actor: { id: "reviewer", type: "internal" },
    conversation: { kind: "dm", threadRef: child.threadRef, audience: [] },
    harness: "pi",
    model: "gpt-5.4",
    readOnly: true,
  });
  const parentAttempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(parentAttempt.lease);
  const assignment = await assignWorkflowReviewer({
    sessions,
    lease: parentAttempt.lease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    reviewerSessionId: child.id,
    definition,
    step: "auditor-1-pass",
  });
  await sessions.releaseLease(parentAttempt.lease);
  const childAttempt = await sessions.acquireLease(child.id, "turn");
  assert.ok(childAttempt.lease);
  await sessions.appendMany(childAttempt.lease, [
    {
      type: "tool_result",
      payload: {
        tool: "skills",
        callId: "runtime-audit-skill",
        action: "read",
        found: true,
        name: "finance-audit",
        provenance: { skillId: "finance-audit", skillVersion: 2, contentDigest: "audit-digest" },
      },
      scopeLabel: scope,
    },
  ]);
  await recordWorkflowReview({
    sessions,
    lease: childAttempt.lease,
    scopeLabel: scope,
    definition,
    runtime: { harnessId: "pi", modelId: "gpt-5-mini" },
    assignment,
    submission: { step: "auditor-1-pass", decision: "pass" },
  });
  await sessions.releaseLease(childAttempt.lease);
  const importAttempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(importAttempt.lease);
  await assert.rejects(
    importWorkflowReview({
      sessions,
      lease: importAttempt.lease,
      scopeLabel: scope,
      parentSessionId: parent.id,
      definition,
      reviewerSessionId: child.id,
      reviewStep: "auditor-1-pass",
    }),
    /reviewer runtime does not match the durable assignment/,
  );
});

test("a sibling or unassigned session cannot be imported as the reviewer", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("parent-2", "dm", scope);
  const unrelated = await sessions.getOrCreateByThread("unrelated", "dm", scope);
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);

  await assert.rejects(
    importWorkflowReview({
      sessions,
      lease: attempt.lease,
      scopeLabel: scope,
      parentSessionId: parent.id,
      definition,
      reviewerSessionId: unrelated.id,
      reviewStep: "auditor-1-pass",
    }),
    /reviewer must be a direct child of the producer session/,
  );
});

test("a direct child without a durable assignment cannot be imported", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("parent-3", "dm", scope);
  const child = await sessions.getOrCreateByThread("child-3", "dm", scope);
  await sessions.setParentSession(child.id, parent.id);
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);

  await assert.rejects(
    importWorkflowReview({
      sessions,
      lease: attempt.lease,
      scopeLabel: scope,
      parentSessionId: parent.id,
      definition,
      reviewerSessionId: child.id,
      reviewStep: "auditor-1-pass",
    }),
    /reviewer is not assigned to this workflow step/,
  );
});

test("a completed review step revokes the child assignment", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("completed-parent", "dm", scope);
  const child = await sessions.getOrCreateByThread("completed-child", "dm", scope);
  await sessions.setParentSession(child.id, parent.id);
  await sessions.setSpawnMeta(child.id, {
    surface: "web",
    actor: { id: "reviewer", type: "internal" },
    conversation: { kind: "dm", threadRef: child.threadRef, audience: [] },
    harness: "pi",
    model: "gpt-5.4",
    readOnly: true,
  });
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);
  await assignWorkflowReviewer({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    parentSessionId: parent.id,
    reviewerSessionId: child.id,
    definition,
    step: "auditor-1-pass",
  });
  assert.ok(
    await activeWorkflowReviewAssignment({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definitions: [definition],
    }),
  );
  await sessions.appendMany(attempt.lease, [
    {
      type: "tool_result",
      payload: {
        tool: "workflow_gate",
        callId: "completed-review-step",
        accepted: true,
        workflowId: definition.id,
        workflowVersion: definition.version,
        step: "auditor-1-pass",
        subject: child.id,
      },
      scopeLabel: scope,
    },
  ]);

  assert.equal(
    await activeWorkflowReviewAssignment({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: child.id,
      definitions: [definition],
    }),
    undefined,
  );
});

test("reassigning a step revokes the prior reviewer", async () => {
  const sessions = createMemorySessionStore();
  const parent = await sessions.getOrCreateByThread("reassigned-parent", "dm", scope);
  const first = await sessions.getOrCreateByThread("reassigned-first", "dm", scope);
  const second = await sessions.getOrCreateByThread("reassigned-second", "dm", scope);
  await sessions.setParentSession(first.id, parent.id);
  await sessions.setParentSession(second.id, parent.id);
  for (const reviewer of [first, second])
    await sessions.setSpawnMeta(reviewer.id, {
      surface: "web",
      actor: { id: reviewer.id, type: "internal" },
      conversation: { kind: "dm", threadRef: reviewer.threadRef, audience: [] },
      harness: "pi",
      model: "gpt-5.4",
      readOnly: true,
    });
  const attempt = await sessions.acquireLease(parent.id, "turn");
  assert.ok(attempt.lease);
  for (const reviewer of [first, second])
    await assignWorkflowReviewer({
      sessions,
      lease: attempt.lease,
      scopeLabel: scope,
      parentSessionId: parent.id,
      reviewerSessionId: reviewer.id,
      definition,
      step: "auditor-1-pass",
    });

  assert.equal(
    await assignedWorkflowReview({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: first.id,
      definition,
      step: "auditor-1-pass",
    }),
    undefined,
  );
  assert.equal(
    await activeWorkflowReviewAssignment({
      sessions,
      parentSessionId: parent.id,
      reviewerSessionId: first.id,
      definitions: [definition],
    }),
    undefined,
  );
  assert.equal(
    (
      await assignedWorkflowReview({
        sessions,
        parentSessionId: parent.id,
        reviewerSessionId: second.id,
        definition,
        step: "auditor-1-pass",
      })
    )?.reviewerSessionId,
    second.id,
  );
});
