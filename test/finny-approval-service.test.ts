import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createFinnyApprovalService } from "../src/finny/approval-service.ts";
import { createAndDeliverFinnyClarification } from "../src/finny/clarification-delivery.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const plan = {
  title: "October close",
  summary: "Prepare and independently certify the close pack.",
  phases: [
    { name: "Prepare", owner: "Producer", dependencies: [] },
    { name: "Certify", owner: "Auditor", dependencies: ["Prepare"] },
  ],
  certification: "All required checks pass",
  deliverable: "Certified close pack",
  destination: "Origin thread",
  clarifications: [{ question: "Which accounting basis should be used?", answer: "Signed contracts" }],
};

const findingPolicy = {
  id: "finny-r5-test",
  maxFindings: 8,
  maxCodeLength: 80,
  maxMessageLength: 2_000,
};

function internalIdentity() {
  return {
    resolve: (actor: { externalId: string }) => ({ id: actor.externalId.toLowerCase(), type: "internal" as const }),
    isInternal: (principal: { type: string }) => principal.type === "internal",
  };
}

test("pending loads the persisted plan presentation by opaque request ID", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  await store.createJob({
    id: jobId,
    scopeId: "personal:approver@example.com",
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({
    scopeId: "personal:approver@example.com",
    jobId,
    requestId,
    authorizedActorId: "approver@example.com",
  });
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async () => undefined,
  });

  assert.deepEqual(await service.pending(requestId), {
    kind: "plan",
    requestId,
    card: {
      title: plan.title,
      summary: plan.summary,
      phases: plan.phases,
      certification: plan.certification,
      deliverable: plan.deliverable,
      destination: plan.destination,
    },
  });
});

test("approve requires the exact internal actor and origin then invokes coordination after commit", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({ scopeId, jobId, requestId, authorizedActorId: "approver@example.com" });
  const callbacks: unknown[] = [];
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async (input) => {
      assert.equal((await store.getJob(scopeId, jobId))?.approval?.action, "approve");
      callbacks.push(input);
    },
  });

  const outcome = await service.decide({
    requestId,
    decision: { kind: "plan", action: "approve" },
    actor: { externalId: "APPROVER@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  });

  assert.deepEqual(outcome, {
    kind: "decision",
    card: { title: plan.title, decision: "approved", detail: "Execution started." },
  });
  assert.deepEqual(callbacks, [{ scopeId, jobId, requestId }]);
});

test("a decided approval returns gone without a duplicate coordinator callback", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({ scopeId, jobId, requestId, authorizedActorId: "approver@example.com" });
  let callbacks = 0;
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async () => void callbacks++,
  });
  const input = {
    requestId,
    decision: { kind: "plan" as const, action: "approve" as const },
    actor: { externalId: "approver@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  };

  await service.decide(input);
  assert.deepEqual(await service.decide(input), { kind: "gone" });
  assert.equal(callbacks, 1);
});

test("pending recovers a durable material clarification with persisted options", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
  });
  await store.createClarificationRequest({
    scopeId,
    jobId,
    requestId,
    authorizedActorId: "approver@example.com",
    question: "Which accounting basis should be used?",
    options: [
      { id: "contracts", label: "Signed contracts", description: "Recognize from executed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: "clarification:accounting-basis",
  });
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async () => undefined,
  });

  assert.deepEqual(await service.pending(requestId), {
    kind: "clarification",
    requestId,
    card: {
      question: "Which accounting basis should be used?",
      options: [
        { id: "contracts", label: "Signed contracts", description: "Recognize from executed contracts" },
        { id: "invoices", label: "Issued invoices" },
      ],
      recommendedOptionId: "contracts",
    },
  });
});

test("clarification selection is bound to the exact actor, origin, and persisted option", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
  });
  await store.createClarificationRequest({
    scopeId,
    jobId,
    requestId,
    authorizedActorId: "approver@example.com",
    question: "Which accounting basis should be used?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: "clarification:selection",
  });
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async () => undefined,
  });

  const outcome = await service.decide({
    requestId,
    decision: { kind: "clarification", action: "select", optionId: "invoices" },
    actor: { externalId: "APPROVER@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  });

  assert.deepEqual(outcome, {
    kind: "result",
    card: {
      title: "Clarification recorded",
      status: "blocked",
      summary: "Revision is required before this plan can be approved. Submit a revised plan to continue.",
    },
  });
  assert.deepEqual((await store.getClarificationRequest(requestId))?.decision, {
    kind: "option",
    optionId: "invoices",
  });
});

test("clarification creation durably enqueues its opaque request to the exact destination idempotently", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = createPostgresFinnyStore(databaseUrl);
  const deliveries = createPostgresDeliveryStore(databaseUrl);
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  const input = {
    store,
    deliveries,
    destination: { type: "slack", target: "C-finance:100.200", threadTs: "100.200" },
    request: {
      scopeId,
      jobId,
      requestId,
      authorizedActorId: "approver@example.com",
      question: "Which accounting basis should be used?",
      options: [
        { id: "contracts", label: "Signed contracts" },
        { id: "invoices", label: "Issued invoices" },
      ],
      recommendedOptionId: "contracts",
      idempotencyKey: "clarification:delivery",
    },
  };

  await store.createApprovalRequest({
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
  });
  const first = await createAndDeliverFinnyClarification(input);
  const replay = await createAndDeliverFinnyClarification(input);
  const pending = await deliveries.pending("slack");

  assert.equal(replay.request.requestId, first.request.requestId);
  assert.equal(replay.delivery.id, first.delivery.id);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0]?.destination, {
    type: "slack",
    target: "C-finance:100.200",
    threadTs: "100.200",
    finnyPlanRequestId: requestId,
  });
});

test("clarification rejects unauthorized actors, copied cards, and unpersisted button options without deciding", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
  });
  await store.createClarificationRequest({
    scopeId,
    jobId,
    requestId,
    authorizedActorId: "approver@example.com",
    question: "Which accounting basis should be used?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: "clarification:guards",
  });
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async () => undefined,
  });
  const base = {
    requestId,
    decision: { kind: "clarification" as const, action: "select" as const, optionId: "contracts" },
    actor: { externalId: "approver@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  };

  await assert.rejects(service.decide({ ...base, actor: { externalId: "other@example.com" } }), /authorized/i);
  await assert.rejects(
    service.decide({ ...base, slack: { channel: "C-copy", messageTs: "200.300", threadTs: "200.100" } }),
    /origin/i,
  );
  await assert.rejects(
    service.decide({ ...base, decision: { kind: "clarification", action: "select", optionId: "injected" } }),
    /option/i,
  );
  assert.equal((await store.getClarificationRequest(requestId))?.decision, undefined);

  assert.deepEqual(await service.decide({ ...base, decision: { kind: "clarification", action: "other" } }), {
    kind: "result",
    card: {
      title: "Clarification recorded",
      status: "blocked",
      summary: "Revision is required before this plan can be approved. Submit a revised plan to continue.",
    },
  });
  assert.deepEqual((await store.getClarificationRequest(requestId))?.decision, { kind: "other" });
  assert.deepEqual(await service.decide({ ...base, decision: { kind: "clarification", action: "other" } }), {
    kind: "gone",
  });
});

test("plan decisions reject external, wrong, and copied-card actors without mutating approval", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({ scopeId, jobId, requestId, authorizedActorId: "approver@example.com" });
  const service = createFinnyApprovalService({
    store,
    identity: {
      resolve: (actor) => ({ id: actor.externalId.toLowerCase(), type: actor.isExternalGuest ? "guest" : "internal" }),
      isInternal: (principal) => principal.type === "internal",
    },
    onApproved: async () => undefined,
  });
  const base = {
    requestId,
    decision: { kind: "plan" as const, action: "reject" as const },
    actor: { externalId: "approver@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  };

  await assert.rejects(
    service.decide({ ...base, actor: { externalId: "approver@example.com", isExternalGuest: true } }),
    /authorized/i,
  );
  await assert.rejects(service.decide({ ...base, actor: { externalId: "other@example.com" } }), /authorized/i);
  await assert.rejects(
    service.decide({ ...base, slack: { channel: "C-copy", messageTs: "200.300", threadTs: "200.100" } }),
    /origin/i,
  );
  assert.equal((await store.getJob(scopeId, jobId))?.approval, undefined);
  assert.equal((await service.pending(requestId))?.kind, "plan");
});

test("clarification request idempotency keys cannot be reused for different material questions", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  const input = {
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
    question: "Which accounting basis should be used?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: "clarification:collision",
  };
  await store.createApprovalRequest({
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
  });
  await store.createClarificationRequest(input);

  await assert.rejects(
    store.createClarificationRequest({ ...input, requestId: randomUUID(), question: "Which currency?" }),
    /idempotency/i,
  );
});

test("concurrent approval clicks settle once and invoke coordination once", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({ scopeId, jobId, requestId, authorizedActorId: "approver@example.com" });
  let callbacks = 0;
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async () => void callbacks++,
  });
  const input = {
    requestId,
    decision: { kind: "plan" as const, action: "approve" as const },
    actor: { externalId: "approver@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  };

  const outcomes = await Promise.allSettled([service.decide(input), service.decide(input)]);
  const decisions = outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value.kind === "decision");
  const conflicts = outcomes.filter(
    (outcome) => outcome.status === "rejected" || (outcome.status === "fulfilled" && outcome.value.kind === "gone"),
  );
  assert.equal(decisions.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(callbacks, 1);
});

test("approval store atomically rejects an origin context that does not match its binding", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const requestId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({ scopeId, jobId, requestId, authorizedActorId: "approver@example.com" });

  await assert.rejects(
    store.recordApproval({
      scopeId,
      jobId,
      requestId,
      actorId: "approver@example.com",
      action: "approve",
      originThreadRef: "slack:C-copy:200.100",
      decidedAt: Date.now(),
    }),
    /origin|binding/i,
  );
  assert.equal((await store.getJob(scopeId, jobId))?.approval, undefined);
});

test("clarification delivery rejects a destination outside the persisted origin thread", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = createPostgresFinnyStore(databaseUrl);
  const deliveries = createPostgresDeliveryStore(databaseUrl);
  const jobId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });

  await store.createApprovalRequest({
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
  });
  await assert.rejects(
    createAndDeliverFinnyClarification({
      store,
      deliveries,
      destination: { type: "slack", target: "C-copy:200.100", threadTs: "200.100" },
      request: {
        scopeId,
        jobId,
        requestId: randomUUID(),
        authorizedActorId: "approver@example.com",
        question: "Which accounting basis should be used?",
        options: [
          { id: "contracts", label: "Signed contracts" },
          { id: "invoices", label: "Issued invoices" },
        ],
        recommendedOptionId: "contracts",
        idempotencyKey: "clarification:wrong-destination",
      },
    }),
    /destination|origin/i,
  );
  assert.equal((await deliveries.pending("slack")).length, 0);
});

test("clarification persistence rejects option sets that Slack cannot render", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  const base = {
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
    question: "Which basis?",
    recommendedOptionId: "option-0",
    idempotencyKey: "clarification:slack-bounds",
  };

  await assert.rejects(
    store.createClarificationRequest({
      ...base,
      options: Array.from({ length: 25 }, (_, index) => ({ id: `option-${index}`, label: `Option ${index}` })),
    }),
    /option|Slack/i,
  );
  await assert.rejects(
    store.createClarificationRequest({
      ...base,
      requestId: randomUUID(),
      idempotencyKey: "clarification:slack-action-id",
      options: [{ id: "x".repeat(255), label: "Too long" }],
      recommendedOptionId: "x".repeat(255),
    }),
    /option|Slack/i,
  );
});

test("a job cannot expose multiple pending approval requests", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const jobId = randomUUID();
  const scopeId = "personal:approver@example.com";
  await store.createJob({
    id: jobId,
    scopeId,
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  await store.createApprovalRequest({
    scopeId,
    jobId,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
  });

  await assert.rejects(
    store.createApprovalRequest({
      scopeId,
      jobId,
      requestId: randomUUID(),
      authorizedActorId: "approver@example.com",
    }),
    /unique|duplicate|approval/i,
  );
});

test("generic clarification atomically withdraws ready approval until the persisted recommendation", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  for (const decision of [
    { kind: "option" as const, optionId: "contracts" },
    { kind: "option" as const, optionId: "invoices" },
    { kind: "other" as const },
  ]) {
    const job = await store.createJob({
      id: randomUUID(),
      scopeId: "personal:approver@example.com",
      plan: {
        ...plan,
        clarifications: [{ question: "Which accounting basis should be used?", answer: "Signed contracts" }],
      },
      policy: initialFinnyPolicy(),
      findingPolicy,
      originThreadRef: "slack:C-finance:100.200",
    });
    const approvalRequestId = randomUUID();
    await store.createApprovalRequest({
      scopeId: job.scopeId,
      jobId: job.id,
      requestId: approvalRequestId,
      authorizedActorId: "approver@example.com",
    });
    assert.ok((await store.getApprovalRequest(approvalRequestId))?.readyAt);
    const clarificationRequestId = randomUUID();
    await store.createClarificationRequest({
      scopeId: job.scopeId,
      jobId: job.id,
      requestId: clarificationRequestId,
      authorizedActorId: "approver@example.com",
      question: "Which accounting basis should be used?",
      options: [
        { id: "contracts", label: "Signed contracts" },
        { id: "invoices", label: "Issued invoices" },
      ],
      recommendedOptionId: "contracts",
      idempotencyKey: `clarification:${job.id}`,
    });
    assert.equal((await store.getApprovalRequest(approvalRequestId))?.readyAt, undefined);
    await assert.rejects(
      store.recordApproval({
        scopeId: job.scopeId,
        jobId: job.id,
        requestId: approvalRequestId,
        actorId: "approver@example.com",
        action: "approve",
        originThreadRef: job.originThreadRef,
        decidedAt: Date.now(),
      }),
      /not ready/i,
    );
    await store.recordClarificationDecision({
      requestId: clarificationRequestId,
      actorId: "approver@example.com",
      originThreadRef: job.originThreadRef,
      decision,
      decidedAt: Date.now(),
    });
    assert.equal(
      (await store.getApprovalRequest(approvalRequestId))?.readyAt !== undefined,
      decision.kind === "option" && decision.optionId === "contracts",
    );
    await assert.rejects(
      store.createClarificationRequest({
        scopeId: job.scopeId,
        jobId: job.id,
        requestId: randomUUID(),
        authorizedActorId: "approver@example.com",
        question: "Which accounting basis should be used?",
        options: [
          { id: "contracts", label: "Signed contracts" },
          { id: "invoices", label: "Issued invoices" },
        ],
        recommendedOptionId: "contracts",
        idempotencyKey: `replacement:${job.id}`,
      }),
      /already has/i,
    );
  }
});

test("approval readiness migration preserves legacy clarification behavior", async () => {
  const url = testDatabaseUrl();
  const store = createPostgresFinnyStore(url);
  const job = await store.createJob({
    id: randomUUID(),
    scopeId: "personal:approver@example.com",
    plan,
    policy: initialFinnyPolicy(),
    findingPolicy,
    originThreadRef: "slack:C-finance:100.200",
  });
  const approvalRequestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId: approvalRequestId,
    authorizedActorId: "approver@example.com",
  });
  await store.createClarificationRequest({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId: randomUUID(),
    authorizedActorId: "approver@example.com",
    question: "Which accounting basis should be used?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: `legacy:${job.id}`,
  });
  const migrationDb = createPgPool(url);
  await migrationDb.q("ALTER TABLE finny_approval_requests DROP COLUMN ready_at");
  await migrationDb.q("DELETE FROM qm_schema_migrations WHERE id='finny/store/0005-approval-readiness'");
  const upgraded = createPostgresFinnyStore(url);
  assert.ok((await upgraded.getApprovalRequest(approvalRequestId))?.readyAt);
});

test("committed decisions survive post-commit dispatch failures for durable recovery", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const scopeId = "personal:approver@example.com";
  const originThreadRef = "slack:C-finance:100.200";
  const create = async () => {
    const jobId = randomUUID();
    const requestId = randomUUID();
    await store.createJob({
      id: jobId,
      scopeId,
      plan,
      policy: initialFinnyPolicy(),
      findingPolicy,
      originThreadRef,
    });
    await store.createApprovalRequest({ scopeId, jobId, requestId, authorizedActorId: "approver@example.com" });
    return { jobId, requestId };
  };
  const errors: Array<{ kind: string; jobId: string }> = [];
  const approved = await create();
  const service = createFinnyApprovalService({
    store,
    identity: internalIdentity(),
    onApproved: async () => {
      throw new Error("dispatch unavailable");
    },
    onClarificationReady: async () => {
      throw new Error("delivery unavailable");
    },
    onPostCommitError: async (_error, input) => {
      errors.push({ kind: input.kind, jobId: input.jobId });
    },
  });
  const approvalOutcome = await service.decide({
    requestId: approved.requestId,
    decision: { kind: "plan", action: "approve" },
    actor: { externalId: "approver@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  });
  assert.equal(approvalOutcome.kind, "decision");
  assert.equal((await store.getJob(scopeId, approved.jobId))?.approval?.action, "approve");

  const clarified = await create();
  const clarificationId = randomUUID();
  await store.createClarificationRequest({
    scopeId,
    jobId: clarified.jobId,
    requestId: clarificationId,
    authorizedActorId: "approver@example.com",
    question: "Which accounting basis should be used?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: `clarification:${clarificationId}`,
  });
  const clarificationOutcome = await service.decide({
    requestId: clarificationId,
    decision: { kind: "clarification", action: "select", optionId: "contracts" },
    actor: { externalId: "approver@example.com" },
    slack: { channel: "C-finance", messageTs: "100.300", threadTs: "100.200" },
  });
  assert.equal(clarificationOutcome.kind, "result");
  assert.equal((await service.pending(clarified.requestId))?.kind, "plan");
  assert.deepEqual(errors, [
    { kind: "approval_dispatch", jobId: approved.jobId },
    { kind: "clarification_delivery", jobId: clarified.jobId },
  ]);
});
