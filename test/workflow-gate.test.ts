import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import {
  activeWorkflowSkillRequirements,
  evaluateWorkflowGate,
  observedWorkflowSkills,
} from "../src/sessions/workflow-gate.ts";
import { scopeId } from "../src/types.ts";

const scope = scopeId("personal", "finance-mvp");

test("a gate derives required skill use from the durable tape instead of producer claims", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-mvp", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const definition = {
    id: "receipts-and-outstanding-ar",
    version: 1,
    steps: [
      {
        id: "auditor-1",
        role: "evidence-auditor",
        requiredSkills: [{ skillId: "netsuite-readonly-finance", contentDigest: "approved-digest" }],
      },
    ],
  } as const;

  const rejected = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1",
      decision: "pass",
      subject: "reviewer-run-1",
    },
  });

  assert.equal(rejected.accepted, false);
  assert.deepEqual(rejected.missingSkills, [
    { skillId: "netsuite-readonly-finance", contentDigest: "approved-digest" },
  ]);

  await sessions.appendMany(lease, [
    {
      type: "tool_call",
      payload: {
        tool: "skills",
        callId: "skill-read-1",
        action: "read",
        name: "netsuite-readonly-finance",
      },
      scopeLabel: scope,
    },
    {
      type: "tool_result",
      payload: {
        tool: "skills",
        callId: "skill-read-1",
        action: "read",
        name: "netsuite-readonly-finance",
        found: true,
        provenance: {
          skillId: "netsuite-readonly-finance",
          skillVersion: 7,
          contentDigest: "approved-digest",
        },
      },
      scopeLabel: scope,
    },
  ]);

  const accepted = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1",
      decision: "pass",
      subject: "reviewer-run-1",
    },
  });

  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.observedSkills, [
    {
      name: "netsuite-readonly-finance",
      skillId: "netsuite-readonly-finance",
      skillVersion: 7,
      contentDigest: "approved-digest",
    },
  ]);
  const persisted = await sessions.getEntries(session.id);
  assert.deepEqual(
    persisted
      .filter((entry) => entry.type === "tool_result")
      .map((entry) => entry.payload)
      .filter((payload) => (payload as { tool?: string }).tool === "workflow_gate")
      .map((payload) => (payload as { accepted?: boolean }).accepted),
    [false, true],
  );
});

test("a workflow rejects skipped gates and same-subject review", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-ordering", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const definition = {
    id: "finance-ordering",
    version: 1,
    steps: [
      { id: "raw-evidence-ready", role: "producer", requiredSkills: [] },
      {
        id: "auditor-1-pass",
        role: "evidence-auditor",
        after: "raw-evidence-ready",
        separateFrom: "raw-evidence-ready",
        evidenceFrom: "raw-evidence-ready",
        requiredSkills: [],
      },
      {
        id: "derived-result-ready",
        role: "calculator",
        after: "auditor-1-pass",
        requiredSkills: [],
      },
    ],
  } as const;

  const skipped = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: { step: "derived-result-ready", decision: "pass", subject: "calculator-1" },
  });
  assert.equal(skipped.accepted, false);
  assert.deepEqual(skipped.blockers, ["required predecessor auditor-1-pass has not passed"]);

  const produced = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "raw-evidence-ready",
      decision: "pass",
      subject: "worker-1",
      outputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(produced.accepted, true);

  const selfReviewed = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "worker-1",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(selfReviewed.accepted, false);
  assert.deepEqual(selfReviewed.blockers, ["subject must differ from raw-evidence-ready"]);

  const staleReview = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "auditor-1",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:stale" }],
    },
  });
  assert.equal(staleReview.accepted, false);
  assert.deepEqual(staleReview.blockers, ["evidence does not match raw-evidence-ready"]);

  const independentlyReviewed = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "auditor-1",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(independentlyReviewed.accepted, true);

  const replayed = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "auditor-2",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(replayed.accepted, false);
  assert.deepEqual(replayed.blockers, ["step auditor-1-pass has already passed"]);
});

test("separation and evidence references fail closed even when they are not the predecessor", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-missing-references", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const result = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition: {
      id: "missing-references",
      version: 1,
      steps: [
        { id: "evidence", role: "producer", requiredSkills: [] },
        { id: "ready", role: "producer", requiredSkills: [] },
        {
          id: "review",
          role: "reviewer",
          after: "ready",
          separateFrom: "evidence",
          evidenceFrom: "evidence",
          requiredSkills: [],
        },
      ],
    },
    submission: { step: "review", decision: "pass", subject: "reviewer" },
  });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.blockers, [
    "required predecessor ready has not passed",
    "required separation gate evidence has not passed",
    "required evidence gate evidence has not passed",
  ]);
});

test("a skill read from an earlier turn cannot satisfy the current gate", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-current-turn", "dm", scope);
  const firstAttempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(firstAttempt.lease);
  const earlierLease = {
    ...firstAttempt.lease,
    turnId: "11111111-1111-4111-8111-111111111111",
  };
  await sessions.appendMany(earlierLease, [
    {
      type: "tool_call",
      payload: { tool: "skills", callId: "old-read", action: "read", name: "finance-audit" },
      scopeLabel: scope,
    },
    {
      type: "tool_result",
      payload: {
        tool: "skills",
        callId: "old-read",
        action: "read",
        name: "finance-audit",
        found: true,
        provenance: { skillId: "finance-audit", skillVersion: 1, contentDigest: "current" },
      },
      scopeLabel: scope,
    },
  ]);
  await sessions.releaseLease(earlierLease);
  const nextAttempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(nextAttempt.lease);
  const currentLease = {
    ...nextAttempt.lease,
    turnId: "22222222-2222-4222-8222-222222222222",
  };

  const result = await evaluateWorkflowGate({
    sessions,
    lease: currentLease,
    scopeLabel: scope,
    definition: {
      id: "current-turn",
      version: 1,
      steps: [
        {
          id: "audit",
          role: "auditor",
          requiredSkills: [{ skillId: "finance-audit", contentDigest: "current" }],
        },
      ],
    },
    submission: { step: "audit", decision: "pass", subject: "auditor" },
  });

  assert.equal(result.accepted, false);
  assert.deepEqual(result.observedSkills, []);
});

test("a registered workflow may bind a skill by stable name and exact content digest", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-skill-name", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  await sessions.appendMany(lease, [
    {
      type: "tool_call",
      payload: { tool: "skills", callId: "named-read", action: "read", name: "finance-audit" },
      scopeLabel: scope,
    },
    {
      type: "tool_result",
      payload: {
        tool: "skills",
        callId: "named-read",
        action: "read",
        name: "finance-audit",
        found: true,
        provenance: { skillId: "runtime-generated-id", skillVersion: 4, contentDigest: "pinned-digest" },
      },
      scopeLabel: scope,
    },
  ]);

  const result = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition: {
      id: "stable-name",
      version: 1,
      steps: [
        {
          id: "audit",
          role: "auditor",
          requiredSkills: [{ skillName: "finance-audit", contentDigest: "pinned-digest" }],
        },
      ],
    },
    submission: { step: "audit", decision: "pass", subject: "auditor" },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.observedSkills[0]?.skillId, "runtime-generated-id");
});

test("a skill body read observes every materialized manifest asset digest", () => {
  const entries = [
    {
      sessionId: "finance-router-assets",
      seq: 1,
      parentSeq: null,
      type: "tool_result",
      payload: {
        tool: "skills",
        action: "read",
        name: "finance-router",
        found: true,
        provenance: {
          skillId: "router-id",
          skillVersion: 3,
          contentDigest: "body-digest",
          materializedContentDigests: ["asset-one", "asset-two"],
        },
      },
      scopeLabel: scope,
      createdAt: 1,
    },
  ] as const;

  assert.deepEqual(observedWorkflowSkills(entries), [
    { name: "finance-router", skillId: "router-id", skillVersion: 3, contentDigest: "body-digest" },
    { name: "finance-router", skillId: "router-id", skillVersion: 3, contentDigest: "asset-one" },
    { name: "finance-router", skillId: "router-id", skillVersion: 3, contentDigest: "asset-two" },
  ]);
});

test("a stage records ancillary skill reads without rejecting required skill evidence", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-stage-allowlist", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  for (const [callId, name, digest] of [
    ["required", "finance-audit", "required-digest"],
    ["extra", "month-end-close", "extra-digest"],
  ]) {
    await sessions.appendMany(lease, [
      {
        type: "tool_call",
        payload: { tool: "skills", callId, action: "read", name },
        scopeLabel: scope,
      },
      {
        type: "tool_result",
        payload: {
          tool: "skills",
          callId,
          action: "read",
          name,
          found: true,
          provenance: { skillId: `${name}-id`, skillVersion: 1, contentDigest: digest },
        },
        scopeLabel: scope,
      },
    ]);
  }

  const result = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition: {
      id: "stage-allowlist",
      version: 1,
      steps: [
        {
          id: "audit",
          role: "auditor",
          requiredSkills: [{ skillName: "finance-audit", contentDigest: "required-digest" }],
        },
      ],
    },
    submission: { step: "audit", decision: "pass", subject: "auditor" },
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(
    result.unexpectedSkills.map((skill) => skill.name),
    ["month-end-close"],
  );
});

test("the host exposes only the next durable workflow stage's skills", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-active-skills", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const definition = {
    id: "active-skills",
    version: 1,
    steps: [
      { id: "route", role: "producer", requiredSkills: [{ skillName: "finance-router" }] },
      { id: "source", role: "producer", after: "route", requiredSkills: [{ skillName: "netsuite-readonly" }] },
    ],
  } as const;
  assert.deepEqual(
    await activeWorkflowSkillRequirements({ sessions, sessionId: session.id, definitions: [definition] }),
    [{ skillName: "finance-router" }],
  );
  await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    observedSkills: [{ name: "finance-router", skillId: "router", skillVersion: 1, contentDigest: "router" }],
    submission: { step: "route", decision: "pass", subject: session.id },
  });
  assert.deepEqual(
    await activeWorkflowSkillRequirements({ sessions, sessionId: session.id, definitions: [definition] }),
    [{ skillName: "netsuite-readonly" }],
  );
});

test("a producer waiting for a separated reviewer receives no reviewer skills", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-review-wait", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const definition = {
    id: "review-wait",
    version: 1,
    steps: [
      { id: "evidence", role: "producer", requiredSkills: [{ skillName: "netsuite-readonly" }] },
      {
        id: "audit",
        role: "auditor",
        after: "evidence",
        separateFrom: "evidence",
        requiredSkills: [{ skillName: "finance-audit" }],
      },
    ],
  } as const;
  await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    observedSkills: [
      {
        name: "netsuite-readonly",
        skillId: "netsuite-readonly",
        skillVersion: 1,
        contentDigest: "netsuite-readonly",
      },
    ],
    submission: { step: "evidence", decision: "pass", subject: session.id },
  });

  assert.deepEqual(
    await activeWorkflowSkillRequirements({ sessions, sessionId: session.id, definitions: [definition] }),
    [],
  );
});

test("a gate evaluates skill reads after its accepted predecessor", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-stage-skills", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const definition = {
    id: "stage-skills",
    version: 1,
    steps: [
      { id: "request", role: "producer", requiredSkills: [{ skillName: "harness" }] },
      { id: "route", role: "producer", after: "request", requiredSkills: [{ skillName: "router" }] },
    ],
  } as const;
  const readSkill = async (callId: string, name: string) =>
    sessions.appendMany(lease, [
      {
        type: "tool_result",
        payload: {
          tool: "skills",
          callId,
          action: "read",
          name,
          found: true,
          provenance: { skillId: name, skillVersion: 1, contentDigest: name },
        },
        scopeLabel: scope,
      },
    ]);
  await readSkill("harness", "harness");
  const request = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: { step: "request", decision: "pass", subject: session.id },
  });
  assert.equal(request.accepted, true);
  await readSkill("router", "router");
  const route = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: { step: "route", decision: "pass", subject: session.id },
  });
  assert.equal(route.accepted, true);
  assert.deepEqual(
    route.observedSkills.map((skill) => skill.name),
    ["router"],
  );
});
