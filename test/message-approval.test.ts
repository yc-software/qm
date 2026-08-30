import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAuditLog, type AuditLog } from "../src/audit/audit-log.ts";
import {
  createMessageApprovalService,
  MESSAGE_APPROVAL_LIMITS,
  messageApprovalContinuationPrompt,
  type MessageApprovalRecord,
  type MessageApprovalRunClaim,
  type MessageApprovalService,
  type MessageApprovalToolInvocation,
  type StageMessageApprovalInput,
} from "../src/core/message-approval.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import {
  defineHarness,
  harnessDelegationAllowed,
  harnessPersistedProviderRecord,
  harnessTurnInputText,
  type HarnessTurnInput,
} from "../src/harness/harness.ts";
import { filterTapeForAudience, foldTape } from "../src/harness/tape-fold.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createPiTools } from "../src/harness/pi-tools.ts";
import { McpToolReportedError } from "../src/mcp/mcp-client.ts";
import { createReaper } from "../src/runs/reaper.ts";
import { replayableRequest } from "../src/core/orchestrator/turn-helpers.ts";
import { messageApprovalMessage } from "../src/slack/approval-cards.ts";
import type { TurnResult } from "../src/types.ts";
import type { MessageApprovalContinuationBinding } from "../src/types.ts";
import type { PendingApprovalRecord } from "../src/types.ts";

const message = (patch: Partial<StageMessageApprovalInput> = {}): StageMessageApprovalInput => ({
  title: "Send launch note",
  recipient: "alex@example.com",
  subject: "Launch",
  body: "Ready to launch",
  ...patch,
});

async function claimRun(
  runs: RunStore,
  runId: string,
  workerId = "worker",
  ttlMs = 1000,
): Promise<MessageApprovalRunClaim> {
  const run = await runs.claimById(runId, workerId, ttlMs);
  assert.ok(run?.leaseToken);
  return { runId: run.id, leaseToken: run.leaseToken, attempt: run.attempts };
}

async function fixture(
  options: {
    records?: ReturnType<typeof createMemoryMap<MessageApprovalRecord>>;
    approvals?: DurableMap<PendingApprovalRecord>;
    auditLog?: AuditLog;
    runs?: RunStore;
    deliveries?: DeliveryStore;
    active?: { value: boolean };
    authorized?: { value: boolean };
    retentionMs?: number;
    tombstoneRetentionMs?: number;
    now?: () => number;
    canonical?: (principalId: string) => string | null;
  } = {},
) {
  const records = options.records ?? createMemoryMap<MessageApprovalRecord>();
  const approvals = options.approvals ?? createMemoryMap<PendingApprovalRecord>();
  const auditLog = options.auditLog ?? createAuditLog();
  const deliveries = options.deliveries ?? createDeliveryStore();
  const sessions = createMemorySessionStore();
  const runs = options.runs ?? createMemoryRunStore().runs;
  const active = options.active ?? { value: true };
  const authorized = options.authorized ?? { value: true };
  const scopeId = "personal:alice@example.com";
  const conversation = {
    kind: "dm" as const,
    threadRef: "slack:C1:100.200",
    audience: [{ id: "alice@example.com", type: "internal" as const }],
  };
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", scopeId, undefined, "slack");
  const createService = () =>
    createMessageApprovalService({
      records,
      approvals,
      auditLog,
      deliveries,
      runs,
      sessions,
      now: options.now,
      retentionMs: options.retentionMs,
      tombstoneRetentionMs: options.tombstoneRetentionMs,
      resolveCanonicalPrincipal: async (principalId) => options.canonical?.(principalId) ?? principalId,
      isActiveInternalPrincipal: async () => active.value,
      isAuthorizedForScope: async () => authorized.value,
    });
  const service = createService();
  let stageSequence = 0;
  const stage = (input = message(), idempotencyKey = `test-stage-${++stageSequence}`) =>
    service.stage({
      idempotencyKey,
      actor: { id: "alice@example.com", type: "internal", displayName: "Alice" },
      sessionId: session.id,
      scopeId,
      surface: "slack",
      conversation,
      originDestination: { type: "slack", target: "C1:100.200" },
      sessionParticipantIds: ["alice@example.com"],
      scopeVersion: "scope-v1",
      harness: "pi",
      model: "model-1",
      thinkingLevel: "high",
      fastMode: true,
      timezone: "UTC",
      message: input,
    });
  return {
    records,
    approvals,
    auditLog,
    deliveries,
    sessions,
    runs,
    active,
    authorized,
    service,
    createService,
    stage,
    session,
    conversation,
  };
}

async function settleClaim(
  f: { runs: RunStore; service: { reconcileContinuation: MessageApprovalServiceReconcile } },
  binding: MessageApprovalContinuationBinding,
  claim: MessageApprovalRunClaim,
  result: TurnResult,
): Promise<boolean> {
  const completed = await f.runs.complete(claim.runId, claim.leaseToken, result);
  await f.service.reconcileContinuation(binding, claim.runId);
  return completed;
}

type MessageApprovalServiceReconcile = (binding: MessageApprovalContinuationBinding, runId: string) => Promise<void>;

function withoutTerminalListeners(runs: RunStore): RunStore {
  return { ...runs, onTerminal() {} };
}

async function assertUnconfirmed(
  f: Awaited<ReturnType<typeof fixture>>,
  approvalId: string,
  hiddenText?: string,
): Promise<void> {
  const record = await f.records.get(approvalId);
  assert.equal(record?.state, "failed");
  assert.equal(record?.continuationStatus, "failed");
  assert.equal(record?.continuationFencePhase, "ambiguous");
  assert.equal(record?.continuationApprovalIds, undefined);
  assert.equal(record?.completedAt, undefined);
  const view = await f.service.get(approvalId);
  assert.ok(view);
  const rendered = messageApprovalMessage(view);
  const card = JSON.stringify(rendered);
  assert.match(card, /QM could not confirm the operation and manual reconciliation is required/);
  assert.doesNotMatch(card, /continuation completed|operation (?:was )?sent|message (?:was )?sent|retry/i);
  if (hiddenText) assert.doesNotMatch(card, new RegExp(hiddenText));
  assert.equal(
    rendered.blocks.some((block) => block.type === "actions"),
    false,
  );
  assert.equal(
    (await f.deliveries.pending("slack")).some((delivery) => delivery.destination.commandApproval),
    false,
  );
}

type EnqueuedRun = Awaited<ReturnType<RunStore["enqueue"]>>["run"];

async function replayContinuationApproval(
  f: Awaited<ReturnType<typeof fixture>>,
  service: Pick<MessageApprovalService, "admitContinuation" | "reconcileContinuation">,
  run: EnqueuedRun,
  binding: MessageApprovalContinuationBinding,
  requestId: string,
  approved: boolean,
  result: TurnResult,
  workerId: string,
): Promise<void> {
  const replay = await f.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, approval: { requestId, approved } },
    maxAttempts: 1,
  });
  const claim = await claimRun(f.runs, replay.run.id, workerId);
  const beforeAdmission = await f.records.get(binding.approvalId);
  assert.ok(await service.admitContinuation(binding, claim, requestId));
  const running = await f.records.get(binding.approvalId);
  const remainingApprovalIds = beforeAdmission?.continuationApprovalIds?.filter((id) => id !== requestId);
  assert.equal(running?.continuationStatus, "running");
  assert.deepEqual(running?.continuationApprovalIds, remainingApprovalIds?.length ? remainingApprovalIds : undefined);
  await f.approvals.delete(requestId);
  assert.equal(await f.runs.complete(replay.run.id, claim.leaseToken, result), true);
  await service.reconcileContinuation(binding, replay.run.id);
}

async function waitForContinuationApprovals(f: Awaited<ReturnType<typeof fixture>>, requestIds: string[]) {
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, run.id);
  assert.ok(await f.service.admitContinuation(binding, claim));
  for (const requestId of requestIds) {
    await f.approvals.put(requestId, {
      sessionId: f.session.id,
      command: requestId,
      createdAt: 1000,
      reason: "approval",
      request: replayableRequest(run.request),
      blocksInput: true,
    });
  }
  assert.equal(
    await settleClaim(f, binding, claim, {
      status: "pending_approval",
      pendingApprovals: requestIds.map((requestId) => ({
        requestId,
        command: requestId,
        reason: "approval",
      })),
    }),
    true,
  );
  return { staged, run, binding };
}

async function runningContinuation(f: Awaited<ReturnType<typeof fixture>>) {
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: staged.version, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, run.id, "fence-worker", 10_000);
  assert.ok(await f.service.admitContinuation(binding, claim));
  return { staged, run, binding, claim };
}

const primarySchema = {
  type: "object",
  properties: {
    draft: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["task_id", "to", "subject", "body"],
      additionalProperties: false,
    },
  },
  required: ["draft"],
  additionalProperties: false,
} as const;

const primaryArgs = {
  draft: { task_id: "task-1", to: ["alex@example.com"], subject: "Launch", body: "Ready to launch" },
};

function mcpInvocation(
  args: unknown,
  schema: Record<string, unknown> = primarySchema,
  serverId = "mail",
  name = "mail_create",
  description = name.replaceAll("_", " "),
): MessageApprovalToolInvocation {
  return {
    name,
    kind: "mcp",
    readOnly: false,
    arguments: args,
    mcp: { serverId, inputSchema: schema, remoteName: name, description },
  };
}

function readMcpInvocation(
  args: unknown,
  schema: Record<string, unknown>,
  serverId = "tasks",
  name = "preview_task",
  description = "Preview task",
): MessageApprovalToolInvocation {
  return {
    ...mcpInvocation(args, schema, serverId, name, description),
    readOnly: true,
  };
}

const taskPreflightSchema = {
  type: "object",
  properties: { taskId: { type: "string" } },
  required: ["taskId"],
  additionalProperties: false,
} as const;

const recipientlessTaskSchema = {
  type: "object",
  properties: {
    taskId: { type: "string" },
    actionId: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["taskId", "actionId", "subject", "body"],
  additionalProperties: false,
} as const;

const recipientlessTaskArgs = {
  taskId: "task-1",
  actionId: "action-1",
  subject: "Launch",
  body: "Ready to launch",
};

async function establishTaskPreflight(
  f: Awaited<ReturnType<typeof fixture>>,
  run: Awaited<ReturnType<typeof runningContinuation>>,
  result: unknown = {
    taskId: "task-1",
    actionId: "action-1",
    recipient: "alex@example.com",
  },
  serverId = "tasks",
  name = "preview_task",
  description = "Preview task",
): Promise<void> {
  const permit = await f.service.beginToolInvocation(
    run.binding,
    run.claim,
    readMcpInvocation({ taskId: "task-1" }, taskPreflightSchema, serverId, name, description),
  );
  assert.ok(permit);
  await permit.finish("success", result);
}

test("staging binds trusted actor, existing session, scope, thread, destination, and runtime context", async () => {
  const f = await fixture();
  const view = await f.stage();
  const record = await f.records.get(view.id);
  assert.equal(record?.actor.id, "alice@example.com");
  assert.equal(record?.sessionId, f.session.id);
  assert.equal(record?.scopeId, "personal:alice@example.com");
  assert.deepEqual(record?.conversation, f.conversation);
  assert.deepEqual(record?.originDestination, { type: "slack", target: "C1:100.200" });
  assert.deepEqual(record?.approvalDestination, { type: "slack", target: "C1:100.200" });
  assert.deepEqual(record?.sessionParticipantIds, ["alice@example.com"]);
  assert.equal(record?.scopeVersion, "scope-v1");
  assert.equal(record?.harness, "pi");
  assert.equal(record?.model, "model-1");
  assert.equal(record?.thinkingLevel, "high");
  assert.equal(record?.fastMode, true);
  assert.equal(record?.timezone, "UTC");
  assert.equal(record?.state, "pending");
  const queued = await f.deliveries.pending("slack");
  assert.deepEqual(queued[0]?.destination.messageApproval, { id: view.id, version: 1 });
  assert.equal(queued[0]?.idempotencyKey, `message-approval:${view.id}:card:1`);
});

test("shared Slack drafts route only to the requester DM while continuation keeps the origin", async () => {
  for (const shared of [
    {
      scopeId: "channel:C-shared",
      conversation: {
        kind: "channel" as const,
        threadRef: "slack:C-shared:100.200",
        channelRef: "C-shared",
        audience: [
          { id: "alice@example.com", type: "internal" as const },
          { id: "external@example.com", type: "guest" as const },
        ],
      },
      originDestination: { type: "slack", target: "C-shared:100.200" },
    },
    {
      scopeId: "group:G-shared",
      conversation: {
        kind: "group" as const,
        threadRef: "slack:G-shared:100.200",
        audience: [
          { id: "alice@example.com", type: "internal" as const },
          { id: "external@example.com", type: "guest" as const },
        ],
      },
      originDestination: { type: "group", target: "G-shared:100.200" },
    },
  ]) {
    const f = await fixture();
    const session = await f.sessions.getOrCreateByThread(
      shared.conversation.threadRef,
      shared.conversation.kind,
      shared.scopeId,
      undefined,
      "slack",
    );
    const staged = await f.service.stage({
      idempotencyKey: `shared-${shared.conversation.kind}`,
      actor: { id: "alice@example.com", type: "internal" },
      sessionId: session.id,
      scopeId: shared.scopeId,
      surface: "slack",
      conversation: shared.conversation,
      originDestination: shared.originDestination,
      sessionParticipantIds: ["alice@example.com", "external@example.com"],
      message: message(),
    });
    const record = (await f.records.get(staged.id))!;
    assert.deepEqual(record.originDestination, shared.originDestination);
    assert.deepEqual(record.approvalDestination, {
      type: "principal",
      target: "alice@example.com",
      audienceScopeId: "personal:alice@example.com",
      onBehalfOf: "alice@example.com",
    });
    const cards = await f.deliveries.pending("principal");
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0]?.destination.messageApproval, { id: staged.id, version: staged.version });
    assert.equal((await f.deliveries.pending(shared.originDestination.type)).length, 0);

    await f.service.decide({
      id: staged.id,
      version: staged.version,
      actorId: "alice@example.com",
      decision: "approve",
    });
    const run = (await f.runs.list())[0]!;
    assert.equal(run.request.deliveryTarget, shared.originDestination.target);
    const claim = await claimRun(f.runs, run.id, `${shared.conversation.kind}-worker`);
    const admission = await f.service.admitContinuation(run.request.messageApprovalContinuation!, claim);
    assert.deepEqual(admission?.destination, shared.originDestination);
  }
});

test("staging succeeds after persistence when card enqueue fails and recovery converges one card", async () => {
  const durableDeliveries = createDeliveryStore();
  let enqueueAttempts = 0;
  const flakyDeliveries = {
    ...durableDeliveries,
    async enqueue(input: Parameters<DeliveryStore["enqueue"]>[0]) {
      enqueueAttempts += 1;
      if (enqueueAttempts === 1) throw new Error("delivery queue unavailable");
      return durableDeliveries.enqueue(input);
    },
  } satisfies DeliveryStore;
  const f = await fixture({ deliveries: flakyDeliveries });
  const staged = await f.stage(message(), "same-turn-call");
  assert.equal(staged.state, "pending");
  assert.equal((await durableDeliveries.pending("slack")).length, 0);
  await f.service.recover();
  const pending = await durableDeliveries.pending("slack");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.idempotencyKey, `message-approval:${staged.id}:card:1`);
  const duplicate = await f.stage(message({ body: "different duplicate body" }), "same-turn-call");
  assert.equal(duplicate.id, staged.id);
  assert.equal(duplicate.body, "Ready to launch");
  assert.equal((await durableDeliveries.pending("slack")).length, 1);
});

test("schema and durable redacted views contain message fields but no executable plan or hidden continuation context", async () => {
  const f = await fixture();
  const view = await f.stage();
  const serializedView = JSON.stringify(await f.service.get(view.id, "alice@example.com"));
  const serializedRecord = JSON.stringify(await f.records.get(view.id));
  for (const absent of [
    "approve",
    "reject",
    "tool",
    "arguments",
    "actor",
    "sessionId",
    "scopeId",
    "conversation",
    "originDestination",
    "approvalDestination",
  ]) {
    assert.equal(serializedView.includes(`"${absent}"`), false, absent);
  }
  for (const absent of ["approve", "reject", "tool", "arguments"]) {
    assert.equal(serializedRecord.includes(`"${absent}"`), false, absent);
  }
  assert.match(serializedView, /alex@example\.com/);
  assert.match(serializedView, /Ready to launch/);
});

test("strict message validation preserves exact accepted values", async () => {
  const f = await fixture();
  const exact = await f.stage({
    title: "  Exact title  ",
    recipient: " exact@example.com ",
    subject: "  S  ",
    body: "  B  ",
  });
  assert.equal(exact.title, "  Exact title  ");
  assert.equal(exact.recipient, " exact@example.com ");
  assert.equal(exact.subject, "  S  ");
  assert.equal(exact.body, "  B  ");
  await assert.rejects(() => f.stage(message({ body: "x".repeat(MESSAGE_APPROVAL_LIMITS.body + 1) })), /exceeds/);
  await assert.rejects(() => f.stage(message({ recipient: "   " })), /required/);
  await assert.rejects(
    () => f.stage({ ...message(), approve: [{ tool: "mail_send", arguments: {} }] } as StageMessageApprovalInput),
    /unknown message approval field/,
  );
  await assert.rejects(
    () =>
      f.service.stage({
        idempotencyKey: "missing-session",
        actor: { id: "alice@example.com", type: "internal" },
        sessionId: "missing",
        scopeId: "personal:alice@example.com",
        surface: "slack",
        conversation: f.conversation,
        originDestination: { type: "slack", target: "C1" },
        message: message(),
      }),
    /existing Slack session/,
  );
});

test("approve, edit, and reject race on pending plus version and only one decision wins", async () => {
  const f = await fixture();
  const first = await f.stage();
  const outcomes = await Promise.all([
    f.service.decide({ id: first.id, version: 1, actorId: "alice@example.com", decision: "approve" }),
    f.service.edit({
      id: first.id,
      version: 1,
      actorId: "alice@example.com",
      recipient: "edited@example.com",
      subject: "Edited",
      body: "Edited body",
    }),
    f.service.decide({ id: first.id, version: 1, actorId: "alice@example.com", decision: "reject" }),
  ]);
  assert.equal(outcomes.filter((result) => result.ok).length, 1);
  const stale = await f.service.decide({
    id: first.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "reject",
  });
  assert.equal(stale.ok ? "" : stale.code, "stale");
});

test("approve enqueues one immutable value-free continuation binding in the original FIFO thread", async () => {
  const f = await fixture();
  const staged = await f.stage();
  const approved = await f.service.edit({
    id: staged.id,
    version: 1,
    actorId: "alice@example.com",
    recipient: "new@example.com",
    subject: "Changed",
    body: "Edited body @channel <@U1>",
  });
  assert.equal(approved.ok, true);
  const record = await f.records.get(staged.id);
  const runs = await f.runs.list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.sessionId, f.conversation.threadRef);
  assert.equal(runs[0]?.dedupKey, `message-approval:${staged.id}:continuation`);
  assert.equal(runs[0]?.maxAttempts, 1);
  assert.equal(runs[0]?.request.text, "");
  assert.equal(runs[0]?.request.origin.kind, "direct");
  assert.deepEqual(runs[0]?.request.actor, { id: "alice@example.com", type: "internal", displayName: "Alice" });
  assert.deepEqual(runs[0]?.request.conversation, f.conversation);
  assert.equal(runs[0]?.request.deliveryTarget, "C1:100.200");
  assert.deepEqual(runs[0]?.request.messageApprovalContinuation, {
    approvalId: staged.id,
    approvalVersion: 2,
    bindingId: record?.continuationBindingId,
  });
  assert.doesNotMatch(JSON.stringify(runs[0]?.request), /new@example\.com|Changed|Edited body/);
  const claim = await claimRun(f.runs, runs[0]!.id);
  const admission = await f.service.admitContinuation(runs[0]!.request.messageApprovalContinuation!, claim);
  assert.deepEqual(admission?.destination, { type: "slack", target: "C1:100.200" });
  assert.deepEqual(admission?.input, {
    approvalId: staged.id,
    approvalVersion: 2,
    bindingId: record?.continuationBindingId,
    recipient: "new@example.com",
    subject: "Changed",
    body: "Edited body @channel <@U1>",
  });
  const current = await f.records.get(staged.id);
  assert.equal(current?.state, "enqueued");
  assert.equal(current?.continuationRunId, runs[0]?.id);
  assert.deepEqual(current?.approvedSnapshot, {
    version: 2,
    recipient: "new@example.com",
    subject: "Changed",
    body: "Edited body @channel <@U1>",
  });
});

test("admission rechecks the lease immediately before revealing continuation plaintext", async () => {
  const memory = createMemoryRunStore().runs;
  let checks = 0;
  const runs = {
    ...memory,
    async ownsLease(runId: string, leaseToken: string, attempt: number) {
      checks += 1;
      if (checks === 2) return false;
      return memory.ownsLease(runId, leaseToken, attempt);
    },
  } satisfies RunStore;
  const f = await fixture({ runs });
  const staged = await f.stage(message({ body: "plaintext must stay hidden" }));
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await memory.list())[0]!;
  const claim = await claimRun(memory, run.id);

  const admission = await f.service.admitContinuation(run.request.messageApprovalContinuation!, claim);
  assert.equal(admission, null);
  assert.equal(checks, 2);
});

test("continuation fence allows reads, blocks writable native and surface calls, and accepts one primary plus one finalization", async () => {
  const f = await fixture();
  const { staged, binding, claim } = await runningContinuation(f);
  assert.equal(
    await f.service.beginToolInvocation(binding, claim, {
      name: "read",
      kind: "native",
      readOnly: true,
      arguments: { path: "notes.txt" },
    }),
    undefined,
  );
  for (const invocation of [
    { name: "execute", kind: "native", readOnly: false, arguments: { command: "send" } },
    { name: "slack", kind: "surface", readOnly: false, arguments: { action: "post", text: "sent" } },
  ] as const) {
    await assert.rejects(
      () => f.service.beginToolInvocation(binding, claim, invocation),
      /blocks writable native and surface tools/,
    );
  }
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(binding, claim, {
        name: "task",
        kind: "native",
        readOnly: true,
        arguments: { prompt: "persist this delegated title" },
      }),
    /blocks delegation tools/,
  );

  const primary = await f.service.beginToolInvocation(binding, claim, mcpInvocation(primaryArgs));
  assert.ok(primary);
  let record = (await f.records.get(staged.id))!;
  assert.equal(record.continuationFencePhase, "primary_calling");
  assert.equal(record.continuationFenceServerId, "mail");
  assert.ok(record.continuationFenceCallToken);
  assert.equal("arguments" in record, false);
  assert.equal("name" in record, false);
  await primary.finish("success");
  record = (await f.records.get(staged.id))!;
  assert.equal(record.continuationFencePhase, "primary_succeeded");
  assert.equal(record.continuationFenceCallToken, undefined);

  const finalSchema = {
    type: "object",
    properties: { task_id: { type: "string" } },
    required: ["task_id"],
    additionalProperties: false,
  };
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        binding,
        claim,
        mcpInvocation({ task_id: "task-1" }, finalSchema, "other", "send_task"),
      ),
    /same MCP server/,
  );
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        binding,
        claim,
        mcpInvocation(
          { task_id: "task-1", body: "second message" },
          {
            type: "object",
            properties: { task_id: { type: "string" }, body: { type: "string" } },
            required: ["task_id", "body"],
            additionalProperties: false,
          },
          "mail",
          "send_task",
        ),
      ),
    /without free text/,
  );
  const finalization = await f.service.beginToolInvocation(
    binding,
    claim,
    mcpInvocation({ task_id: "task-1" }, finalSchema, "mail", "send_task"),
  );
  assert.ok(finalization);
  assert.equal((await f.records.get(staged.id))?.continuationFencePhase, "finalizing");
  await finalization.finish("success");
  assert.equal((await f.records.get(staged.id))?.continuationFencePhase, "closed");
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        binding,
        claim,
        mcpInvocation({ task_id: "task-1" }, finalSchema, "mail", "send_task"),
      ),
    /write fence is closed/,
  );
  assert.equal(
    await f.service.beginToolInvocation(binding, claim, {
      name: "mail_status",
      kind: "mcp",
      readOnly: true,
      arguments: { draft_id: "d1" },
      mcp: { serverId: "mail", inputSchema: finalSchema },
    }),
    undefined,
  );
  assert.equal(await settleClaim(f, binding, claim, { status: "ok" }), true);
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "completed");
});

test("lease expiry inside the fence update returns no permit and marks the call ambiguous", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  const ownsLease = f.runs.ownsLease.bind(f.runs);
  let checks = 0;
  f.runs.ownsLease = async (...args) => {
    checks += 1;
    return checks === 2 ? false : ownsLease(...args);
  };
  await assert.rejects(
    () => f.service.beginToolInvocation(run.binding, run.claim, mcpInvocation(primaryArgs)),
    /lost its run lease before MCP transport/,
  );
  assert.equal(checks, 2);
  assert.equal((await f.records.get(run.staged.id))?.continuationFencePhase, "ambiguous");
});

test("continuation fence rejects altered, decoy, schema-invalid, missing-subject, and wrong-recipient primary calls", async () => {
  const cases: Array<{ args: unknown; schema?: Record<string, unknown> }> = [
    {
      args: {
        draft: { to: ["alex@example.com"], subject: "Launch", body: "Altered" },
        approvedBody: "Ready to launch",
      },
      schema: {
        type: "object",
        properties: {
          draft: primarySchema.properties.draft,
          approvedBody: { type: "string" },
        },
        required: ["draft", "approvedBody"],
        additionalProperties: false,
      },
    },
    { args: { draft: { to: ["alex@example.com"], subject: "Launch" } } },
    { args: { draft: { to: ["alex@example.com"], subject: "", body: "Ready to launch" } } },
    { args: { draft: { to: ["mallory@example.com"], subject: "Launch", body: "Ready to launch" } } },
  ];
  for (const candidate of cases) {
    const f = await fixture();
    const { staged, binding, claim } = await runningContinuation(f);
    await assert.rejects(
      () => f.service.beginToolInvocation(binding, claim, mcpInvocation(candidate.args, candidate.schema)),
      /do not match the approved draft/,
    );
    assert.equal((await f.records.get(staged.id))?.continuationFencePhase, "ready");
  }
});

test("continuation primary requires an exact recipient field or a read-preflight-bound workflow resource", async () => {
  const directRecipient = {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["to", "subject", "body"],
    additionalProperties: false,
  };
  const exact = await fixture();
  const exactRun = await runningContinuation(exact);
  assert.ok(
    await exact.service.beginToolInvocation(
      exactRun.binding,
      exactRun.claim,
      mcpInvocation({ to: "alex@example.com", subject: "Launch", body: "Ready to launch" }, directRecipient),
    ),
  );

  const withoutRecipient = {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" } },
    required: ["subject", "body"],
    additionalProperties: false,
  };
  const missingRecipient = await fixture();
  const missingRecipientRun = await runningContinuation(missingRecipient);
  await assert.rejects(
    () =>
      missingRecipient.service.beginToolInvocation(
        missingRecipientRun.binding,
        missingRecipientRun.claim,
        mcpInvocation({ subject: "Launch", body: "Ready to launch" }, withoutRecipient),
      ),
    /do not match the approved draft/,
  );

  const boundTask = {
    type: "object",
    properties: { task_id: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["task_id", "subject", "body"],
    additionalProperties: false,
  };
  const externallyBound = await fixture();
  const externallyBoundRun = await runningContinuation(externallyBound);
  await assert.rejects(
    () =>
      externallyBound.service.beginToolInvocation(
        externallyBoundRun.binding,
        externallyBoundRun.claim,
        mcpInvocation({ task_id: "task-1", subject: "Launch", body: "Ready to launch" }, boundTask),
      ),
    /do not match the approved draft/,
  );
  await establishTaskPreflight(
    externallyBound,
    externallyBoundRun,
    {
      taskId: "task-1",
      recipient: "alex@example.com",
    },
    "mail",
  );
  assert.ok(
    await externallyBound.service.beginToolInvocation(
      externallyBoundRun.binding,
      externallyBoundRun.claim,
      mcpInvocation({ task_id: "task-1", subject: "Launch", body: "Ready to launch" }, boundTask),
    ),
  );
});

test("recipientless primary binds only to an exact-recipient singular read preflight on the same server", async () => {
  const accepted = await fixture();
  const acceptedRun = await runningContinuation(accepted);
  const preview = await accepted.service.beginToolInvocation(
    acceptedRun.binding,
    acceptedRun.claim,
    readMcpInvocation({ taskId: "task-1" }, taskPreflightSchema),
  );
  assert.ok(preview);
  await preview.finish("success", {
    content: [
      {
        type: "text",
        text: JSON.stringify({ taskId: "task-1", actionId: "action-1", recipient: "alex@example.com" }),
      },
    ],
  });
  const record = (await accepted.records.get(acceptedRun.staged.id))!;
  assert.equal(record.continuationPreflightServerId, "tasks");
  assert.deepEqual(
    record.continuationPreflightIdentifiers?.map(({ category }) => category),
    ["action", "task"],
  );
  assert.ok(record.continuationPreflightIdentifiers?.every(({ hash }) => /^[a-f0-9]{64}$/.test(hash)));
  assert.doesNotMatch(
    JSON.stringify(record.continuationPreflightIdentifiers),
    /task-1|action-1|alex@example\.com|Launch|Ready to launch/,
  );
  assert.ok(
    await accepted.service.beginToolInvocation(
      acceptedRun.binding,
      acceptedRun.claim,
      mcpInvocation(recipientlessTaskArgs, recipientlessTaskSchema, "tasks", "edit_task", "Edit task"),
    ),
  );

  for (const args of [
    { ...recipientlessTaskArgs, taskId: "task-2" },
    { ...recipientlessTaskArgs, actionId: "action-2" },
  ]) {
    const different = await fixture();
    const differentRun = await runningContinuation(different);
    await establishTaskPreflight(different, differentRun);
    await assert.rejects(
      () =>
        different.service.beginToolInvocation(
          differentRun.binding,
          differentRun.claim,
          mcpInvocation(args, recipientlessTaskSchema, "tasks", "edit_task", "Edit task"),
        ),
      /do not match the approved draft/,
    );
  }

  const otherServer = await fixture();
  const otherServerRun = await runningContinuation(otherServer);
  await establishTaskPreflight(otherServer, otherServerRun);
  await assert.rejects(
    () =>
      otherServer.service.beginToolInvocation(
        otherServerRun.binding,
        otherServerRun.claim,
        mcpInvocation(recipientlessTaskArgs, recipientlessTaskSchema, "mail", "edit_task", "Edit task"),
      ),
    /do not match the approved draft/,
  );
});

test("preflight binds identifiers only inside one exact-recipient requested-resource subtree", async () => {
  const split = await fixture();
  const splitRun = await runningContinuation(split);
  await establishTaskPreflight(split, splitRun, {
    contacts: [{ recipient: "alex@example.com" }],
    tasks: [{ taskId: "task-1", actionId: "action-1" }],
  });
  assert.equal((await split.records.get(splitRun.staged.id))?.continuationPreflightIdentifiers, undefined);

  const mixedRecipient = await fixture();
  const mixedRecipientRun = await runningContinuation(mixedRecipient);
  await establishTaskPreflight(mixedRecipient, mixedRecipientRun, {
    taskId: "task-1",
    recipient: "alex@example.com",
    contact: { recipient: "mallory@example.com" },
  });
  assert.equal(
    (await mixedRecipient.records.get(mixedRecipientRun.staged.id))?.continuationPreflightIdentifiers,
    undefined,
  );

  const duplicate = await fixture();
  const duplicateRun = await runningContinuation(duplicate);
  await establishTaskPreflight(duplicate, duplicateRun, {
    tasks: [
      { taskId: "task-1", recipient: "alex@example.com" },
      { taskId: "task-1", recipient: "alex@example.com" },
    ],
  });
  assert.equal((await duplicate.records.get(duplicateRun.staged.id))?.continuationPreflightIdentifiers, undefined);

  const nested = await fixture();
  const nestedRun = await runningContinuation(nested);
  await establishTaskPreflight(nested, nestedRun, {
    task: {
      taskId: "task-1",
      recipient: "alex@example.com",
      actions: [{ actionId: "action-1" }],
    },
    unrelated: { taskId: "task-2", actionId: "action-2", recipient: "mallory@example.com" },
  });
  const nestedRecord = (await nested.records.get(nestedRun.staged.id))!;
  assert.deepEqual(
    nestedRecord.continuationPreflightIdentifiers?.map(({ category }) => category),
    ["action", "task"],
  );
  assert.ok(
    await nested.service.beginToolInvocation(
      nestedRun.binding,
      nestedRun.claim,
      mcpInvocation(recipientlessTaskArgs, recipientlessTaskSchema, "tasks", "edit_task", "Edit task"),
    ),
  );
});

test("wrong-recipient, broad, failed, and ambiguous reads establish no preflight binding", async () => {
  const wrongRecipient = await fixture();
  const wrongRecipientRun = await runningContinuation(wrongRecipient);
  await establishTaskPreflight(wrongRecipient, wrongRecipientRun, {
    taskId: "task-1",
    actionId: "action-1",
    recipient: "mallory@example.com",
  });
  assert.equal(
    (await wrongRecipient.records.get(wrongRecipientRun.staged.id))?.continuationPreflightServerId,
    undefined,
  );
  await assert.rejects(
    () =>
      wrongRecipient.service.beginToolInvocation(
        wrongRecipientRun.binding,
        wrongRecipientRun.claim,
        mcpInvocation(recipientlessTaskArgs, recipientlessTaskSchema, "tasks", "edit_task", "Edit task"),
      ),
    /write fence is closed/,
  );

  for (const name of ["list_tasks", "search_tasks", "query_tasks", "get_all_tasks", "bulk_get_tasks"]) {
    const broad = await fixture();
    const broadRun = await runningContinuation(broad);
    assert.equal(
      await broad.service.beginToolInvocation(
        broadRun.binding,
        broadRun.claim,
        readMcpInvocation({ taskId: "task-1" }, taskPreflightSchema, "tasks", name, name.replaceAll("_", " ")),
      ),
      undefined,
    );
    assert.equal((await broad.records.get(broadRun.staged.id))?.continuationPreflightServerId, undefined);
  }

  for (const outcome of ["failure", "ambiguous"] as const) {
    const unsuccessful = await fixture();
    const unsuccessfulRun = await runningContinuation(unsuccessful);
    const permit = await unsuccessful.service.beginToolInvocation(
      unsuccessfulRun.binding,
      unsuccessfulRun.claim,
      readMcpInvocation({ taskId: "task-1" }, taskPreflightSchema),
    );
    assert.ok(permit);
    assert.equal(
      (await unsuccessful.records.get(unsuccessfulRun.staged.id))?.continuationFencePhase,
      "preflight_calling",
    );
    await permit.finish(outcome, {
      taskId: "task-1",
      actionId: "action-1",
      recipient: "alex@example.com",
    });
    assert.equal((await unsuccessful.records.get(unsuccessfulRun.staged.id))?.continuationPreflightServerId, undefined);
    assert.equal((await unsuccessful.records.get(unsuccessfulRun.staged.id))?.continuationFencePhase, "ambiguous");
  }
});

test("preflight binding cannot be swapped across restart", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  await establishTaskPreflight(f, run);
  const restarted = f.createService();
  await assert.rejects(
    () =>
      restarted.beginToolInvocation(
        run.binding,
        run.claim,
        readMcpInvocation({ taskId: "task-2" }, taskPreflightSchema),
      ),
    /preflight fence changed concurrently/,
  );
  const record = (await f.records.get(run.staged.id))!;
  assert.equal(
    record.continuationPreflightIdentifiers?.find(({ category }) => category === "task")?.hash,
    createHash("sha256").update("task-1").digest("hex"),
  );
  await assert.rejects(
    () =>
      restarted.beginToolInvocation(
        run.binding,
        run.claim,
        mcpInvocation(
          { ...recipientlessTaskArgs, taskId: "task-2", actionId: "action-2" },
          recipientlessTaskSchema,
          "tasks",
          "edit_task",
          "Edit task",
        ),
      ),
    /do not match the approved draft/,
  );
});

test("primary requires the approved nonempty subject and accepts the exact subject", async () => {
  const omitted = await fixture();
  const omittedRun = await runningContinuation(omitted);
  await assert.rejects(
    () =>
      omitted.service.beginToolInvocation(
        omittedRun.binding,
        omittedRun.claim,
        mcpInvocation(
          { to: "alex@example.com", body: "Ready to launch" },
          {
            type: "object",
            properties: { to: { type: "string" }, body: { type: "string" } },
            required: ["to", "body"],
            additionalProperties: false,
          },
        ),
      ),
    /do not match the approved draft/,
  );

  const exact = await fixture();
  const exactRun = await runningContinuation(exact);
  assert.ok(
    await exact.service.beginToolInvocation(
      exactRun.binding,
      exactRun.claim,
      mcpInvocation(
        { to: "alex@example.com", subject: "Launch", body: "Ready to launch" },
        {
          type: "object",
          properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
          required: ["to", "subject", "body"],
          additionalProperties: false,
        },
      ),
    ),
  );
});

test("continuation primary recursively rejects extra recipients, attachments, payload text, and open schemas", async () => {
  const cases: Array<{ args: unknown; schema: Record<string, unknown> }> = [
    {
      args: { to: "alex@example.com", cc: ["alex@example.com", "mallory@example.com"], body: "Ready to launch" },
      schema: {
        type: "object",
        properties: {
          to: { type: "string" },
          cc: { type: "array", maxItems: 2, items: { type: "string" } },
          body: { type: "string" },
        },
        required: ["to", "cc", "body"],
        additionalProperties: false,
      },
    },
    {
      args: { bcc: ["mallory@example.com"], body: "Ready to launch" },
      schema: {
        type: "object",
        properties: { bcc: { type: "array", maxItems: 1, items: { type: "string" } }, body: { type: "string" } },
        required: ["bcc", "body"],
        additionalProperties: false,
      },
    },
    {
      args: { body: "Ready to launch", attachment_url: "https://example.com/private", attachment_name: "note.txt" },
      schema: {
        type: "object",
        properties: {
          body: { type: "string" },
          attachment_url: { type: "string", maxLength: 200 },
          attachment_name: { type: "string", maxLength: 100 },
        },
        required: ["body", "attachment_url", "attachment_name"],
        additionalProperties: false,
      },
    },
    {
      args: { body: "Ready to launch", extra_payload: "secret free text" },
      schema: {
        type: "object",
        properties: { body: { type: "string" }, extra_payload: { type: "string", maxLength: 100 } },
        required: ["body", "extra_payload"],
        additionalProperties: false,
      },
    },
    {
      args: { body: "Ready to launch", unknown: "bounded" },
      schema: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: true,
      },
    },
  ];
  for (const candidate of cases) {
    const f = await fixture();
    const run = await runningContinuation(f);
    await assert.rejects(
      () => f.service.beginToolInvocation(run.binding, run.claim, mcpInvocation(candidate.args, candidate.schema)),
      /do not match the approved draft/,
    );
  }
});

test("continuation primary rejects repeated exact-message bulk arrays", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  const draft = {
    taskId: "task-1",
    to: "alex@example.com",
    subject: "Launch",
    body: "Ready to launch",
  };
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        run.binding,
        run.claim,
        mcpInvocation(
          { messages: [draft, draft] },
          {
            type: "object",
            properties: {
              messages: {
                type: "array",
                maxItems: 2,
                items: {
                  type: "object",
                  properties: {
                    taskId: { type: "string" },
                    to: { type: "string" },
                    subject: { type: "string" },
                    body: { type: "string" },
                  },
                  required: ["taskId", "to", "subject", "body"],
                  additionalProperties: false,
                },
              },
            },
            required: ["messages"],
            additionalProperties: false,
          },
        ),
      ),
    /do not match the approved draft/,
  );
});

test("continuation primary rejects duplicate exact drafts in sibling objects", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  const draftSchema = {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["to", "subject", "body"],
    additionalProperties: false,
  };
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        run.binding,
        run.claim,
        mcpInvocation(
          {
            first: { to: "alex@example.com", subject: "Launch", body: "Ready to launch" },
            second: { to: "alex@example.com", subject: "Launch", body: "Ready to launch" },
          },
          {
            type: "object",
            properties: { first: draftSchema, second: draftSchema },
            required: ["first", "second"],
            additionalProperties: false,
          },
        ),
      ),
    /do not match the approved draft/,
  );
});

test("continuation primary validates closed local references and locally bounds identifier strings", async () => {
  const schema = {
    type: "object",
    $defs: {
      task: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          to: { type: "string" },
          subject: { type: "string" },
          action: { type: "string" },
        },
        required: ["task_id", "to", "subject", "action"],
        additionalProperties: false,
      },
    },
    properties: { task: { $ref: "#/$defs/task" } },
    required: ["task"],
    additionalProperties: false,
  };
  const valid = await fixture();
  const validRun = await runningContinuation(valid);
  assert.ok(
    await valid.service.beginToolInvocation(
      validRun.binding,
      validRun.claim,
      mcpInvocation(
        {
          task: {
            task_id: "task-1",
            to: "alex@example.com",
            subject: "Launch",
            action: "Ready to launch",
          },
        },
        schema,
      ),
    ),
  );
  for (const args of [
    {
      task: {
        task_id: "task-1",
        to: "alex@example.com",
        subject: "Launch",
        action: "Ready to launch",
        unknown: "value",
      },
    },
    {
      task: {
        task_id: "x".repeat(513),
        to: "alex@example.com",
        subject: "Launch",
        action: "Ready to launch",
      },
    },
  ]) {
    const f = await fixture();
    const run = await runningContinuation(f);
    await assert.rejects(
      () => f.service.beginToolInvocation(run.binding, run.claim, mcpInvocation(args, schema)),
      /do not match the approved draft/,
    );
  }
});

test("continuation primary rejects redirecting, sensitive, and unknown identifier categories", async () => {
  for (const [field, value] of [
    ["contact_id", "alex@example.com"],
    ["prospectId", "alex@example.com"],
    ["message_ids", "alex@example.com"],
    ["draftIds", "alex@example.com"],
    ["recipient_id", "alex@example.com"],
    ["audienceId", "alex@example.com"],
    ["to_id", "alex@example.com"],
    ["targetId", "resource-1"],
    ["destination_id", "resource-1"],
    ["user_id", "resource-1"],
    ["accountId", "resource-1"],
    ["channel_id", "resource-1"],
    ["fileId", "resource-1"],
    ["attachment_id", "resource-1"],
    ["workspaceId", "resource-1"],
    ["team_id", "resource-1"],
    ["tenantId", "resource-1"],
    ["credential_id", "resource-1"],
    ["tokenId", "resource-1"],
    ["secret_id", "resource-1"],
    ["fooId", "resource-1"],
  ] as const) {
    const f = await fixture();
    const run = await runningContinuation(f);
    const schema = {
      type: "object",
      properties: { [field]: { type: "string" }, body: { type: "string" } },
      required: [field, "body"],
      additionalProperties: false,
    };
    await assert.rejects(
      () =>
        f.service.beginToolInvocation(
          run.binding,
          run.claim,
          mcpInvocation({ [field]: value, body: "Ready to launch" }, schema),
        ),
      /do not match the approved draft/,
    );
  }
});

test("continuation primary permits only explicitly constrained non-identifier scalars", async () => {
  const valid = await fixture();
  const validRun = await runningContinuation(valid);
  assert.ok(
    await valid.service.beginToolInvocation(
      validRun.binding,
      validRun.claim,
      mcpInvocation(
        { to: "alex@example.com", subject: "Launch", body: "Ready to launch", mode: "edit", notify: false },
        {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            mode: { enum: ["edit"] },
            notify: { const: false },
          },
          required: ["to", "subject", "body", "mode", "notify"],
          additionalProperties: false,
        },
      ),
    ),
  );
  const invalid = await fixture();
  const invalidRun = await runningContinuation(invalid);
  await assert.rejects(
    () =>
      invalid.service.beginToolInvocation(
        invalidRun.binding,
        invalidRun.claim,
        mcpInvocation(
          { to: "alex@example.com", subject: "Launch", body: "Ready to launch", mode: "edit" },
          {
            type: "object",
            properties: {
              to: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" },
              mode: { type: "string", maxLength: 20 },
            },
            required: ["to", "subject", "body", "mode"],
            additionalProperties: false,
          },
        ),
      ),
    /do not match the approved draft/,
  );
});

test("continuation finalization cannot bind approved body text as a task identifier", async () => {
  const f = await fixture();
  const staged = await f.stage(message({ body: "ok" }));
  await f.service.decide({ id: staged.id, version: staged.version, actorId: "alice@example.com", decision: "approve" });
  const continuation = (await f.runs.list())[0]!;
  const binding = continuation.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, continuation.id);
  assert.ok(await f.service.admitContinuation(binding, claim));
  const primary = await f.service.beginToolInvocation(
    binding,
    claim,
    mcpInvocation(
      { to: "alex@example.com", subject: "Launch", body: "ok" },
      {
        type: "object",
        properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
      "tasks",
      "edit_task",
      "Edit task",
    ),
  );
  assert.ok(primary);
  await primary.finish("success");
  assert.deepEqual((await f.records.get(staged.id))?.continuationFenceIdentifiers, []);
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        binding,
        claim,
        mcpInvocation(
          { task_id: "ok" },
          {
            type: "object",
            properties: { task_id: { type: "string" } },
            required: ["task_id"],
            additionalProperties: false,
          },
          "tasks",
          "complete_task",
          "Complete task",
        ),
      ),
    /without free text/,
  );
});

test("continuation primary rejects a subject on a subjectless draft and accepts an absent or empty subject", async () => {
  const schema = {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["to", "body"],
    additionalProperties: false,
  };
  for (const args of [
    { to: "alex@example.com", body: "Ready to launch" },
    { to: "alex@example.com", subject: "", body: "Ready to launch" },
  ]) {
    const f = await fixture();
    const staged = await f.stage(message({ subject: undefined }));
    await f.service.decide({
      id: staged.id,
      version: staged.version,
      actorId: "alice@example.com",
      decision: "approve",
    });
    const run = (await f.runs.list())[0]!;
    const binding = run.request.messageApprovalContinuation!;
    const claim = await claimRun(f.runs, run.id);
    assert.ok(await f.service.admitContinuation(binding, claim));
    assert.ok(await f.service.beginToolInvocation(binding, claim, mcpInvocation(args, schema)));
  }
  const f = await fixture();
  const staged = await f.stage(message({ subject: undefined }));
  await f.service.decide({ id: staged.id, version: staged.version, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, run.id);
  assert.ok(await f.service.admitContinuation(binding, claim));
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        binding,
        claim,
        mcpInvocation({ to: "alex@example.com", subject: "Injected", body: "Ready to launch" }, schema),
      ),
    /do not match the approved draft/,
  );
});

test("recipientless preflight-bound edits require one subject path even for a subjectless draft", async () => {
  const f = await fixture();
  const staged = await f.stage(message({ subject: undefined }));
  await f.service.decide({ id: staged.id, version: staged.version, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, run.id);
  assert.ok(await f.service.admitContinuation(binding, claim));
  const running = { staged, run, binding, claim };
  await establishTaskPreflight(f, running);
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        binding,
        claim,
        mcpInvocation(
          { taskId: "task-1", actionId: "action-1", body: "Ready to launch" },
          {
            type: "object",
            properties: { taskId: { type: "string" }, actionId: { type: "string" }, body: { type: "string" } },
            required: ["taskId", "actionId", "body"],
            additionalProperties: false,
          },
          "tasks",
          "edit_task",
          "Edit task",
        ),
      ),
    /do not match the approved draft/,
  );
  assert.ok(
    await f.service.beginToolInvocation(
      binding,
      claim,
      mcpInvocation(
        { taskId: "task-1", actionId: "action-1", subject: "", body: "Ready to launch" },
        recipientlessTaskSchema,
        "tasks",
        "edit_task",
        "Edit task",
      ),
    ),
  );
});

test("continuation finalization binds a conservative complete tool to primary semantic identifiers", async () => {
  const primaryTaskSchema = {
    type: "object",
    properties: {
      taskId: { type: "string" },
      actionId: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["taskId", "actionId", "subject", "body"],
    additionalProperties: false,
  };
  const finalSchema = {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
  };
  const f = await fixture();
  const run = await runningContinuation(f);
  await establishTaskPreflight(f, run);
  const primary = await f.service.beginToolInvocation(
    run.binding,
    run.claim,
    mcpInvocation(
      { taskId: "task-1", actionId: "action-1", subject: "Launch", body: "Ready to launch" },
      primaryTaskSchema,
      "tasks",
      "edit_task_action",
      "Edit task action",
    ),
  );
  assert.ok(primary);
  await primary.finish("success", {
    taskId: "extra-task",
    previous: { taskId: "previous-task", actionId: "previous-action" },
    unrelated: { taskId: "unrelated-task", enrollmentId: "unrelated-enrollment" },
  });
  const record = (await f.records.get(run.staged.id))!;
  assert.deepEqual(
    record.continuationFenceIdentifiers?.map(({ category }) => category),
    ["action", "task"],
  );
  assert.ok(record.continuationFenceIdentifiers?.every(({ hash }) => /^[a-f0-9]{64}$/.test(hash)));
  assert.equal(
    record.continuationFenceIdentifiers?.find(({ category }) => category === "task")?.hash,
    createHash("sha256").update("task-1").digest("hex"),
  );
  assert.deepEqual(
    record.continuationFenceIdentifiers?.map(({ category, hash }) => ({ category, hash })),
    [
      { category: "action", hash: createHash("sha256").update("action-1").digest("hex") },
      { category: "task", hash: createHash("sha256").update("task-1").digest("hex") },
    ],
  );
  assert.doesNotMatch(JSON.stringify(record.continuationFenceIdentifiers), /task-1|action-1|Ready to launch|Launch/);

  for (const invocation of [
    mcpInvocation({ taskId: "task-1" }, finalSchema, "tasks", "delete_task", "Delete task"),
    mcpInvocation({ taskId: "task-1" }, finalSchema, "tasks", "update_task", "Update task"),
    mcpInvocation({ taskId: "task-2" }, finalSchema, "tasks", "complete_task", "Complete task"),
    mcpInvocation({ taskId: "extra-task" }, finalSchema, "tasks", "complete_task", "Complete task"),
    mcpInvocation({ taskId: "previous-task" }, finalSchema, "tasks", "complete_task", "Complete task"),
    mcpInvocation({ taskId: "unrelated-task" }, finalSchema, "tasks", "complete_task", "Complete task"),
    {
      ...mcpInvocation({ taskId: "task-1" }, finalSchema, "tasks", "notify_task", "Complete task"),
      name: "complete_task",
    },
    ...["contact_id", "prospectId", "message_ids", "draftIds", "recipient_id", "targetId"].map((field) =>
      mcpInvocation(
        { [field]: "alex@example.com" },
        {
          type: "object",
          properties: { [field]: { type: "string" } },
          required: [field],
          additionalProperties: false,
        },
        "tasks",
        "complete_task",
        "Complete task",
      ),
    ),
    ...[
      "complete_and_charge_task",
      "approve_and_publish",
      "complete_and_delete_task",
      "complete_and_removed_task",
      "complete_and_cancelling_task",
      "complete_and_skipped_task",
      "complete_and_purge_task",
      "complete_and_archived_task",
      "complete_and_disabling_task",
      "complete_and_revoked_task",
      "complete_and_resetting_task",
      "complete_and_terminated_task",
      "complete_and_destroyed_task",
      "complete_and_erasing_task",
      "complete_and_cleared_task",
      "complete_and_dropped_task",
      "complete_and_blocking_task",
      "complete_and_unsubscribed_task",
    ].map((name) => mcpInvocation({ taskId: "task-1" }, finalSchema, "tasks", name)),
    mcpInvocation(
      { task_id: "action-1" },
      {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
        additionalProperties: false,
      },
      "tasks",
      "complete_task",
      "Complete task",
    ),
    mcpInvocation(
      { taskId: "task-1", force: true },
      {
        type: "object",
        properties: { taskId: { type: "string" }, force: { const: true } },
        required: ["taskId", "force"],
        additionalProperties: false,
      },
      "tasks",
      "complete_task",
      "Complete task",
    ),
    mcpInvocation(
      { task: { taskId: "task-1" } },
      {
        type: "object",
        properties: {
          task: {
            type: "object",
            properties: { taskId: { type: "string" } },
            required: ["taskId"],
            additionalProperties: false,
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
      "tasks",
      "complete_task",
      "Complete task",
    ),
    mcpInvocation(
      { options: {} },
      {
        type: "object",
        properties: { options: { type: "object", properties: {}, additionalProperties: false } },
        required: ["options"],
        additionalProperties: false,
      },
      "tasks",
      "complete_task",
      "Complete task",
    ),
    mcpInvocation(
      [{ taskId: "task-1" }],
      {
        type: "array",
        maxItems: 1,
        items: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
      "tasks",
      "complete_task",
      "Complete task",
    ),
  ]) {
    await assert.rejects(() => f.service.beginToolInvocation(run.binding, run.claim, invocation), /without free text/);
  }

  const finalization = await f.service.beginToolInvocation(
    run.binding,
    run.claim,
    mcpInvocation({ taskId: "task-1" }, finalSchema, "tasks", "complete_task", "Complete task"),
  );
  assert.ok(finalization);
  await finalization.finish("success");
  assert.equal((await f.records.get(run.staged.id))?.continuationFencePhase, "closed");
});

test("continuation finalization normalizes identifier names and rejects every non-ID field", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  await establishTaskPreflight(f, run, {
    taskId: "task-1",
    recipient: "alex@example.com",
  });
  const primary = await f.service.beginToolInvocation(
    run.binding,
    run.claim,
    mcpInvocation(
      { taskId: "task-1", subject: "Launch", body: "Ready to launch" },
      {
        type: "object",
        properties: { taskId: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
        required: ["taskId", "subject", "body"],
        additionalProperties: false,
      },
      "tasks",
      "edit_task",
      "Edit task",
    ),
  );
  assert.ok(primary);
  await primary.finish("success");
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        run.binding,
        run.claim,
        mcpInvocation(
          { task_id: "task-1", status: "completed" },
          {
            type: "object",
            properties: { task_id: { type: "string" }, status: { enum: ["completed", "pending"] } },
            required: ["task_id", "status"],
            additionalProperties: false,
          },
          "tasks",
          "complete_task",
          "Complete task",
        ),
      ),
    /without free text/,
  );
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        run.binding,
        run.claim,
        mcpInvocation(
          { task_id: "task-1", status: "completed", notify: true },
          {
            type: "object",
            properties: {
              task_id: { type: "string" },
              status: { const: "completed" },
              notify: { enum: [true] },
            },
            required: ["task_id", "status", "notify"],
            additionalProperties: false,
          },
          "tasks",
          "complete_task",
          "Complete task",
        ),
      ),
    /without free text/,
  );

  const accepted = await fixture();
  const acceptedRun = await runningContinuation(accepted);
  await establishTaskPreflight(accepted, acceptedRun, { taskId: "task-1", recipient: "alex@example.com" });
  const acceptedPrimary = await accepted.service.beginToolInvocation(
    acceptedRun.binding,
    acceptedRun.claim,
    mcpInvocation(
      { taskId: "task-1", subject: "Launch", body: "Ready to launch" },
      {
        type: "object",
        properties: { taskId: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
        required: ["taskId", "subject", "body"],
        additionalProperties: false,
      },
      "tasks",
      "edit_task",
      "Edit task",
    ),
  );
  assert.ok(acceptedPrimary);
  await acceptedPrimary.finish("success");
  const camelFinalization = mcpInvocation(
    { taskId: "task-1" },
    {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    "tasks",
    "completeTask",
    "Notify and publish",
  );
  camelFinalization.name = "mcp__tasks__completeTask";
  assert.ok(await accepted.service.beginToolInvocation(acceptedRun.binding, acceptedRun.claim, camelFinalization));
});

test("continuation finalization cannot bind an identifier from a primary result", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  const primary = await f.service.beginToolInvocation(
    run.binding,
    run.claim,
    mcpInvocation(
      { to: "alex@example.com", subject: "Launch", action: "Ready to launch" },
      {
        type: "object",
        properties: { to: { type: "string" }, subject: { type: "string" }, action: { type: "string" } },
        required: ["to", "subject", "action"],
        additionalProperties: false,
      },
      "tasks",
      "edit_task_action",
      "Edit task action",
    ),
  );
  assert.ok(primary);
  await primary.finish("success", {
    content: [{ type: "text", text: JSON.stringify({ taskId: "result-task-1", title: "private title" }) }],
  });
  const record = (await f.records.get(run.staged.id))!;
  assert.doesNotMatch(JSON.stringify(record), /result-task-1|private title/);
  assert.deepEqual(record.continuationFenceIdentifiers, []);
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        run.binding,
        run.claim,
        mcpInvocation(
          { task_id: "result-task-1" },
          {
            type: "object",
            properties: { task_id: { type: "string" } },
            required: ["task_id"],
            additionalProperties: false,
          },
          "tasks",
          "complete_task",
          "Complete task",
        ),
      ),
    /without free text/,
  );
});

test("continuation result identifiers cannot substitute for primary argument identifiers", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  const primary = await f.service.beginToolInvocation(
    run.binding,
    run.claim,
    mcpInvocation(
      { to: "alex@example.com", subject: "Launch", body: "Ready to launch" },
      {
        type: "object",
        properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
      "tasks",
      "edit_task",
      "Edit task",
    ),
  );
  assert.ok(primary);
  await primary.finish("success", {
    content: [
      {
        type: "text",
        text: JSON.stringify({ action_id: "result-1", foo_id: "result-1", body: "result-1" }),
      },
    ],
  });
  await assert.rejects(
    () =>
      f.service.beginToolInvocation(
        run.binding,
        run.claim,
        mcpInvocation(
          { task_id: "result-1" },
          {
            type: "object",
            properties: { task_id: { type: "string" } },
            required: ["task_id"],
            additionalProperties: false,
          },
          "tasks",
          "complete_task",
          "Complete task",
        ),
      ),
    /without free text/,
  );
});

test("every primary transport failure and abandoned call stays durably closed across restart", async () => {
  const failed = await fixture();
  const failedRun = await runningContinuation(failed);
  const first = await failed.service.beginToolInvocation(
    failedRun.binding,
    failedRun.claim,
    mcpInvocation(primaryArgs),
  );
  assert.ok(first);
  await first.finish("failure");
  assert.equal((await failed.records.get(failedRun.staged.id))?.continuationFencePhase, "ambiguous");
  await assert.rejects(
    () => failed.createService().beginToolInvocation(failedRun.binding, failedRun.claim, mcpInvocation(primaryArgs)),
    /write fence is closed/,
  );

  const ambiguous = await fixture();
  const ambiguousRun = await runningContinuation(ambiguous);
  const uncertain = await ambiguous.service.beginToolInvocation(
    ambiguousRun.binding,
    ambiguousRun.claim,
    mcpInvocation(primaryArgs),
  );
  assert.ok(uncertain);
  await uncertain.finish("ambiguous");
  assert.equal((await ambiguous.records.get(ambiguousRun.staged.id))?.continuationFencePhase, "ambiguous");
  await assert.rejects(
    () =>
      ambiguous
        .createService()
        .beginToolInvocation(ambiguousRun.binding, ambiguousRun.claim, mcpInvocation(primaryArgs)),
    /write fence is closed/,
  );

  const abandoned = await fixture();
  const abandonedRun = await runningContinuation(abandoned);
  assert.ok(
    await abandoned.service.beginToolInvocation(abandonedRun.binding, abandonedRun.claim, mcpInvocation(primaryArgs)),
  );
  assert.equal((await abandoned.records.get(abandonedRun.staged.id))?.continuationFencePhase, "primary_calling");
  await assert.rejects(
    () =>
      abandoned
        .createService()
        .beginToolInvocation(abandonedRun.binding, abandonedRun.claim, mcpInvocation(primaryArgs)),
    /write fence is closed/,
  );
});

test("a remote side effect followed by MCP isError is ambiguous and cannot be invoked twice", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  let remoteCalls = 0;
  const ref = {
    current: {
      async callMcpTool() {
        remoteCalls += 1;
        throw new McpToolReportedError("remote side effect then isError");
      },
    } as never,
    beforeToolInvocation: (invocation: MessageApprovalToolInvocation) =>
      f.service.beginToolInvocation(run.binding, run.claim, invocation),
  };
  const tool = createPiTools(ref, {
    mcpTools: () => [
      {
        name: "mail_create",
        serverId: "mail",
        remoteName: "mail_create",
        description: "mail create",
        inputSchema: primarySchema,
        readOnly: false,
      },
    ],
  }).find(({ name }) => name === "mail_create");
  assert.ok(tool);
  const execute = tool.execute.bind(tool) as unknown as (callId: string, args: unknown) => Promise<unknown>;
  const first = await execute("call-1", primaryArgs);
  assert.match(JSON.stringify(first), /remote side effect then isError/);
  assert.equal(remoteCalls, 1);
  assert.equal((await f.records.get(run.staged.id))?.continuationFencePhase, "ambiguous");
  await assert.rejects(() => execute("call-2", primaryArgs), /write fence is closed/);
  assert.equal(remoteCalls, 1);
  assert.equal(await settleClaim(f, run.binding, run.claim, { status: "silent" }), true);
  await assertUnconfirmed(f, run.staged.id, "remote side effect then isError");
});

test("an ambiguous continuation fence overrides an ok run result", async () => {
  const f = await fixture();
  const run = await runningContinuation(f);
  const permit = await f.service.beginToolInvocation(run.binding, run.claim, mcpInvocation(primaryArgs));
  assert.ok(permit);
  await permit.finish("ambiguous");
  assert.equal(await settleClaim(f, run.binding, run.claim, { status: "ok", reply: "operation completed" }), true);
  await assertUnconfirmed(f, run.staged.id, "operation completed");
});

test("restart reconciliation keeps an ambiguous continuation unconfirmed despite canonical success", async () => {
  const f = await fixture({ runs: withoutTerminalListeners(createMemoryRunStore().runs) });
  const run = await runningContinuation(f);
  const permit = await f.service.beginToolInvocation(run.binding, run.claim, mcpInvocation(primaryArgs));
  assert.ok(permit);
  await permit.finish("ambiguous");
  assert.equal(
    await f.runs.complete(run.claim.runId, run.claim.leaseToken, { status: "ok", reply: "remote success" }),
    true,
  );
  const restarted = f.createService();
  await restarted.reconcileContinuation(run.binding, run.run.id);
  await assertUnconfirmed(f, run.staged.id, "remote success");
});

test("stale completion CAS cannot replace an ambiguous continuation fence", async () => {
  const backing = createMemoryMap<MessageApprovalRecord>();
  let makeSettlementStale = false;
  const records: DurableMap<MessageApprovalRecord> = {
    ...backing,
    async update(id, update) {
      if (makeSettlementStale) {
        makeSettlementStale = false;
        await backing.update!(id, (current) => ({
          ...current,
          continuationFencePhase: "ambiguous",
          version: current.version + 1,
        }));
      }
      return backing.update!(id, update);
    },
  };
  const f = await fixture({ records, runs: withoutTerminalListeners(createMemoryRunStore().runs) });
  const run = await runningContinuation(f);
  makeSettlementStale = true;
  assert.equal(await f.runs.complete(run.claim.runId, run.claim.leaseToken, { status: "ok" }), true);
  await f.service.reconcileContinuation(run.binding, run.run.id);
  await assertUnconfirmed(f, run.staged.id);
});

test("command approval replay preserves preflight bindings and cannot repeat the approved call", async () => {
  const f = await fixture();
  const { staged, run, binding, claim } = await runningContinuation(f);
  await establishTaskPreflight(f, { staged, run, binding, claim });
  const preflightIdentifiers = (await f.records.get(staged.id))?.continuationPreflightIdentifiers;
  const primary = await f.service.beginToolInvocation(
    binding,
    claim,
    mcpInvocation(recipientlessTaskArgs, recipientlessTaskSchema, "tasks", "edit_task", "Edit task"),
  );
  assert.ok(primary);
  await primary.finish("success");
  await f.approvals.put("finalize-approval", {
    sessionId: f.session.id,
    command: "complete_task",
    createdAt: Date.now(),
    reason: "approval",
    request: replayableRequest(run.request),
    blocksInput: true,
  });
  assert.equal(
    await settleClaim(f, binding, claim, {
      status: "pending_approval",
      pendingApprovals: [{ requestId: "finalize-approval", command: "complete_task", reason: "approval" }],
    }),
    true,
  );
  const replay = await f.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, approval: { requestId: "finalize-approval", approved: true } },
    maxAttempts: 1,
  });
  const replayClaim = await claimRun(f.runs, replay.run.id, "replay-worker", 10_000);
  assert.ok(await f.createService().admitContinuation(binding, replayClaim, "finalize-approval"));
  assert.deepEqual((await f.records.get(staged.id))?.continuationPreflightIdentifiers, preflightIdentifiers);
  await assert.rejects(
    () =>
      f
        .createService()
        .beginToolInvocation(
          binding,
          replayClaim,
          mcpInvocation(recipientlessTaskArgs, recipientlessTaskSchema, "tasks", "edit_task", "Edit task"),
        ),
    /without free text/,
  );
  assert.equal((await f.records.get(staged.id))?.continuationFencePhase, "primary_succeeded");
});

test("concurrent recovery and restart return the same deduplicated continuation run", async () => {
  const f = await fixture();
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const firstRun = (await f.runs.list())[0]!;
  const record = (await f.records.get(staged.id))!;
  await f.records.put(staged.id, {
    ...record,
    state: "approved",
    version: 2,
    continuationBindingId: "inactive-binding",
    continuationRunId: undefined,
    enqueuedAt: undefined,
  });
  const restartedA = f.createService();
  const restartedB = f.createService();
  await Promise.all([restartedA.recover(), restartedB.recover(), restartedA.recover(), restartedB.recover()]);
  const runs = await f.runs.list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, firstRun.id);
  assert.equal((await f.records.get(staged.id))?.continuationRunId, firstRun.id);
});

test("admission followed by lease expiry fails closed without a second claimant or stale settlement", async () => {
  const f = await fixture();
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const firstClaim = await f.runs.claimById(run.id, "worker-1", 50);
  assert.ok(firstClaim?.leaseToken);
  const staleClaim = {
    runId: firstClaim.id,
    leaseToken: firstClaim.leaseToken,
    attempt: firstClaim.attempts,
  };
  const binding = run.request.messageApprovalContinuation!;
  assert.ok(await f.service.admitContinuation(binding, staleClaim));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const reaper = createReaper(f.runs, f.sessions, { intervalMs: 60_000 });
  assert.deepEqual(await reaper.sweep(), { requeued: 0, parked: 1 });
  const reclaimed = await f.runs.claimById(run.id, "worker-2", 1000);
  assert.equal(reclaimed, null);
  assert.equal(await f.service.admitContinuation(binding, staleClaim), null);
  assert.equal(await f.runs.complete(run.id, staleClaim.leaseToken, { status: "ok" }), false);
  await f.service.reconcileContinuation(binding, run.id);
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "failed");
  assert.doesNotMatch(JSON.stringify(await f.service.get(staged.id)), /leaseToken|continuationAttempt/);
});

test("waiting continuations admit only corresponding explicit approval replays across multiple steps", async () => {
  const f = await fixture();
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const initialClaim = await claimRun(f.runs, run.id, "initial");
  assert.ok(await f.service.admitContinuation(binding, initialClaim));
  const firstWaiting: TurnResult = {
    status: "pending_approval",
    pendingApprovals: [{ requestId: "command-1", command: "first", reason: "approval" }],
  };
  assert.equal(await settleClaim(f, binding, initialClaim, firstWaiting), true);
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "waiting");
  assert.ok(
    (await f.deliveries.pending("slack")).some(
      (delivery) => delivery.destination.commandApproval?.requestIds[0] === "command-1",
    ),
  );
  assert.deepEqual(replayableRequest(run.request).messageApprovalContinuation, binding);
  assert.equal(await f.service.admitContinuation(binding, initialClaim), null);
  const replayA = await f.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, approval: { requestId: "command-1", approved: true } },
    maxAttempts: 1,
  });
  const replayClaimA = await claimRun(f.runs, replayA.run.id, "approval-a");
  assert.equal(await f.service.admitContinuation(binding, replayClaimA, "other-command"), null);
  const explicit = await Promise.all([
    f.service.admitContinuation(binding, replayClaimA, "command-1"),
    f.createService().admitContinuation(binding, replayClaimA, "command-1"),
  ]);
  assert.equal(explicit.filter(Boolean).length, 1);
  const secondWaiting: TurnResult = {
    status: "pending_approval",
    pendingApprovals: [{ requestId: "command-2", command: "second", reason: "approval" }],
  };
  assert.equal(await settleClaim(f, binding, replayClaimA, secondWaiting), true);
  assert.equal(
    (await f.deliveries.pending("slack")).filter((delivery) => delivery.destination.commandApproval).length,
    2,
  );
  assert.equal(await f.service.admitContinuation(binding, replayClaimA, "command-1"), null);
  const replayC = await f.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, approval: { requestId: "command-2", approved: true } },
    maxAttempts: 1,
  });
  const replayClaimC = await claimRun(f.runs, replayC.run.id, "approval-c");
  assert.ok(await f.service.admitContinuation(binding, replayClaimC, "command-2"));
  assert.equal(await settleClaim(f, binding, replayClaimC, { status: "ok" }), true);
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "completed");
});

test("approving one of two continuation approvals preserves the sibling as blocking and clickable", async () => {
  const f = await fixture();
  const { staged, run, binding } = await waitForContinuationApprovals(f, ["approve-first", "approve-second"]);

  await replayContinuationApproval(
    f,
    f.service,
    run,
    binding,
    "approve-first",
    true,
    {
      status: "pending_approval",
      pendingApprovals: [
        { requestId: "approve-second", command: "approve-second", reason: "approval" },
        { requestId: "approve-second", command: "approve-second", reason: "approval" },
      ],
    },
    "approve-first-worker",
  );

  const record = await f.records.get(staged.id);
  assert.equal(record?.continuationStatus, "waiting");
  assert.deepEqual(record?.continuationApprovalIds, ["approve-second"]);
  assert.ok(await f.approvals.get("approve-second"));
  assert.deepEqual(
    (await f.deliveries.pending("slack")).filter((delivery) => delivery.destination.commandApproval).at(-1)?.destination
      .commandApproval?.requestIds,
    ["approve-second"],
  );
});

test("approving two continuation approvals sequentially completes only after the second", async () => {
  const f = await fixture();
  const { staged, run, binding } = await waitForContinuationApprovals(f, ["sequential-first", "sequential-second"]);

  await replayContinuationApproval(
    f,
    f.service,
    run,
    binding,
    "sequential-first",
    true,
    { status: "ok", reply: "first complete" },
    "sequential-first-worker",
  );
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "waiting");
  assert.deepEqual((await f.records.get(staged.id))?.continuationApprovalIds, ["sequential-second"]);

  await replayContinuationApproval(
    f,
    f.service,
    run,
    binding,
    "sequential-second",
    true,
    { status: "ok", reply: "all complete" },
    "sequential-second-worker",
  );
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "completed");
  assert.equal((await f.records.get(staged.id))?.continuationApprovalIds, undefined);
});

test("denying one continuation approval fails the continuation and removes sibling blockers", async () => {
  const f = await fixture();
  const { staged, run, binding } = await waitForContinuationApprovals(f, ["deny-first", "deny-second"]);

  await replayContinuationApproval(
    f,
    f.service,
    run,
    binding,
    "deny-first",
    false,
    { status: "refused", reason: "approval denied for deny-first" },
    "deny-worker",
  );

  const record = await f.records.get(staged.id);
  assert.equal(record?.continuationStatus, "failed");
  assert.equal(record?.continuationApprovalIds, undefined);
  assert.equal(await f.approvals.get("deny-first"), null);
  assert.equal(await f.approvals.get("deny-second"), null);
});

test("expiry after the first continuation approval cleans the remaining sibling", async () => {
  let clock = 1000;
  const f = await fixture({ now: () => clock, retentionMs: 100 });
  const { staged, run, binding } = await waitForContinuationApprovals(f, ["expiry-first", "expiry-second"]);

  await replayContinuationApproval(
    f,
    f.service,
    run,
    binding,
    "expiry-first",
    true,
    { status: "ok" },
    "expiry-first-worker",
  );
  assert.deepEqual((await f.records.get(staged.id))?.continuationApprovalIds, ["expiry-second"]);

  clock += 101;
  await f.service.sweep();

  assert.equal((await f.records.get(staged.id))?.state, "expired");
  assert.equal((await f.records.get(staged.id))?.continuationApprovalIds, undefined);
  assert.equal(await f.approvals.get("expiry-second"), null);
});

test("restart between continuation approval clicks preserves and resumes the sibling", async () => {
  const f = await fixture();
  const { staged, run, binding } = await waitForContinuationApprovals(f, ["restart-first", "restart-second"]);

  await replayContinuationApproval(
    f,
    f.service,
    run,
    binding,
    "restart-first",
    true,
    { status: "ok" },
    "restart-first-worker",
  );
  const restarted = f.createService();
  await restarted.recover();
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "waiting");
  assert.deepEqual((await f.records.get(staged.id))?.continuationApprovalIds, ["restart-second"]);
  assert.ok(await f.approvals.get("restart-second"));

  await replayContinuationApproval(
    f,
    restarted,
    run,
    binding,
    "restart-second",
    true,
    { status: "ok" },
    "restart-second-worker",
  );
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "completed");
});

test("continuation results classify blocking approvals before status and otherwise fail closed", async () => {
  const f = await fixture();
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, run.id);
  assert.ok(await f.service.admitContinuation(binding, claim));
  assert.equal(
    await settleClaim(f, binding, claim, {
      status: "pending_approval",
      pendingApprovals: [{ requestId: "command", command: "x", reason: "approval" }],
    }),
    true,
  );
  assert.equal((await f.records.get(staged.id))?.continuationStatus, "waiting");

  for (const status of ["queued", "refused", "failed", "react"] as const) {
    const next = await fixture();
    const draft = await next.stage();
    await next.service.decide({ id: draft.id, version: 1, actorId: "alice@example.com", decision: "approve" });
    const nextRun = (await next.runs.list())[0]!;
    const nextBinding = nextRun.request.messageApprovalContinuation!;
    const nextClaim = await claimRun(next.runs, nextRun.id);
    assert.ok(await next.service.admitContinuation(nextBinding, nextClaim));
    assert.equal(await settleClaim(next, nextBinding, nextClaim, { status }), true);
    assert.equal((await next.records.get(draft.id))?.continuationStatus, "failed", status);
  }
});

test("ok with blocking pending approvals remains waiting and queues the normal command approval", async () => {
  const f = await fixture();
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, run.id);
  assert.ok(await f.service.admitContinuation(binding, claim));
  assert.equal(
    await settleClaim(f, binding, claim, {
      status: "ok",
      reply: "Draft prepared",
      pendingApprovals: [
        { requestId: "command-after-ok", command: "mail_send", reason: "approval", blocksInput: true },
      ],
    }),
    true,
  );
  const record = await f.records.get(staged.id);
  assert.equal(record?.continuationStatus, "waiting");
  assert.deepEqual(record?.continuationApprovalIds, ["command-after-ok"]);
  assert.ok(
    (await f.deliveries.pending("slack")).some(
      (delivery) => delivery.destination.commandApproval?.requestIds[0] === "command-after-ok",
    ),
  );
});

test("missing and unknown continuation results fail closed", async () => {
  for (const result of [{ status: "pending_approval" }, {}]) {
    const f = await fixture();
    const staged = await f.stage();
    await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
    const run = (await f.runs.list())[0]!;
    const binding = run.request.messageApprovalContinuation!;
    const claim = await claimRun(f.runs, run.id);
    assert.ok(await f.service.admitContinuation(binding, claim));
    assert.equal(await settleClaim(f, binding, claim, result as never), true);
    assert.equal((await f.records.get(staged.id))?.continuationStatus, "failed");
  }
});

test("recovery reconstructs command approval delivery after settlement commits before Slack updates", async () => {
  const durableDeliveries = createDeliveryStore();
  let failCommandDelivery = true;
  const deliveries = {
    ...durableDeliveries,
    async enqueue(input: Parameters<DeliveryStore["enqueue"]>[0]) {
      if (input.destination.commandApproval && failCommandDelivery) {
        failCommandDelivery = false;
        throw new Error("crash before Slack update");
      }
      return durableDeliveries.enqueue(input);
    },
  } satisfies DeliveryStore;
  const f = await fixture({ deliveries });
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const binding = run.request.messageApprovalContinuation!;
  const claim = await claimRun(f.runs, run.id);
  assert.ok(await f.service.admitContinuation(binding, claim));
  assert.equal(
    await settleClaim(f, binding, claim, {
      status: "pending_approval",
      pendingApprovals: [{ requestId: "recovered-command", command: "mail_send", reason: "approval" }],
    }),
    true,
  );
  assert.equal(
    (await durableDeliveries.pending("slack")).some((delivery) => delivery.destination.commandApproval),
    false,
  );
  await f.createService().recover();
  const recovered = (await durableDeliveries.pending("slack")).filter(
    (delivery) => delivery.destination.commandApproval?.requestIds[0] === "recovered-command",
  );
  assert.equal(recovered.length, 1);
  await f.createService().recover();
  assert.equal(
    (await durableDeliveries.pending("slack")).filter(
      (delivery) => delivery.destination.commandApproval?.requestIds[0] === "recovered-command",
    ).length,
    1,
  );
});

test("waiting expiry clears every blocking continuation approval with durable audit events", async () => {
  let clock = 1000;
  const f = await fixture({ now: () => clock, retentionMs: 100 });
  const { staged } = await waitForContinuationApprovals(f, ["command-expiry", "quarantine-expiry"]);
  clock += 101;

  await f.service.sweep();

  assert.equal(await f.approvals.get("command-expiry"), null);
  assert.equal(await f.approvals.get("quarantine-expiry"), null);
  const tombstone = await f.records.get(staged.id);
  assert.equal(tombstone?.state, "expired");
  assert.equal(tombstone?.continuationApprovalIds, undefined);
  assert.deepEqual(
    (await f.auditLog.events())
      .filter((event) => event.action === "command_approval.expire")
      .map((event) => event.resource)
      .sort(),
    ["command-expiry", "quarantine-expiry"],
  );
});

test("cleanup failure after one approval retries only the remaining continuation approval after restart", async () => {
  let clock = 1000;
  const durableApprovals = createMemoryMap<PendingApprovalRecord>();
  let failed = false;
  const approvals = {
    ...durableApprovals,
    async deleteIf(id: string, predicate: (value: PendingApprovalRecord) => boolean) {
      if (id === "cleanup-second" && !failed) {
        failed = true;
        throw new Error("crash during approval cleanup");
      }
      return durableApprovals.deleteIf!(id, predicate);
    },
  } satisfies DurableMap<PendingApprovalRecord>;
  const f = await fixture({ approvals, now: () => clock, retentionMs: 100 });
  const { staged } = await waitForContinuationApprovals(f, ["cleanup-first", "cleanup-second"]);
  clock += 101;

  await assert.rejects(() => f.service.sweep(), /crash during approval cleanup/);
  assert.equal(await approvals.get("cleanup-first"), null);
  assert.ok(await approvals.get("cleanup-second"));
  assert.deepEqual((await f.records.get(staged.id))?.continuationApprovalIds, ["cleanup-second"]);

  await f.createService().recover();

  assert.equal(await approvals.get("cleanup-second"), null);
  assert.equal((await f.records.get(staged.id))?.continuationApprovalIds, undefined);
  assert.equal((await f.auditLog.events()).filter((event) => event.action === "command_approval.expire").length, 2);
});

test("click racing waiting expiry has one winner and never admits an expired continuation", async () => {
  let clock = 1000;
  const f = await fixture({ now: () => clock, retentionMs: 100 });
  const { staged, run, binding } = await waitForContinuationApprovals(f, ["racing-command"]);
  const replay = await f.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, approval: { requestId: "racing-command", approved: true } },
    maxAttempts: 1,
  });
  const replayClaim = await claimRun(f.runs, replay.run.id, "racing-click");
  clock += 101;

  const [admission] = await Promise.all([
    f.service.admitContinuation(binding, replayClaim, "racing-command"),
    f.service.sweep(),
  ]);
  const winner = await f.records.get(staged.id);

  assert.equal(winner?.state === "expired" && admission !== null, false);
  if (admission) {
    assert.equal(winner?.continuationStatus, "running");
  } else {
    assert.equal(winner?.state, "expired");
    assert.equal(await f.approvals.get("racing-command"), null);
    assert.equal(await f.service.admitContinuation(binding, replayClaim, "racing-command"), null);
  }

  let expiryClock = 1000;
  const durableApprovals = createMemoryMap<PendingApprovalRecord>();
  let cleanupStartedResolve!: () => void;
  let cleanupReleaseResolve!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    cleanupStartedResolve = resolve;
  });
  const cleanupRelease = new Promise<void>((resolve) => {
    cleanupReleaseResolve = resolve;
  });
  const approvals = {
    ...durableApprovals,
    async deleteIf(id: string, predicate: (value: PendingApprovalRecord) => boolean) {
      cleanupStartedResolve();
      await cleanupRelease;
      return durableApprovals.deleteIf!(id, predicate);
    },
  } satisfies DurableMap<PendingApprovalRecord>;
  const expired = await fixture({ approvals, now: () => expiryClock, retentionMs: 100 });
  const expiredContinuation = await waitForContinuationApprovals(expired, ["expiry-winner"]);
  const expiredReplay = await expired.runs.enqueue({
    sessionId: expiredContinuation.run.sessionId,
    request: {
      ...expiredContinuation.run.request,
      approval: { requestId: "expiry-winner", approved: true },
    },
    maxAttempts: 1,
  });
  const expiredClaim = await claimRun(expired.runs, expiredReplay.run.id, "late-click");
  expiryClock += 101;
  const sweeping = expired.service.sweep();
  await cleanupStarted;

  assert.equal(
    await expired.service.admitContinuation(expiredContinuation.binding, expiredClaim, "expiry-winner"),
    null,
  );
  assert.equal((await expired.records.get(expiredContinuation.staged.id))?.state, "expired");
  cleanupReleaseResolve();
  await sweeping;
});

test("waiting cleanup tombstone stays redacted and retained through card acknowledgement until cleanup succeeds", async () => {
  let clock = 1000;
  const durableApprovals = createMemoryMap<PendingApprovalRecord>();
  let cleanupAvailable = false;
  const approvals = {
    ...durableApprovals,
    async deleteIf(id: string, predicate: (value: PendingApprovalRecord) => boolean) {
      if (!cleanupAvailable) throw new Error("approval cleanup unavailable");
      return durableApprovals.deleteIf!(id, predicate);
    },
  } satisfies DurableMap<PendingApprovalRecord>;
  const f = await fixture({
    approvals,
    now: () => clock,
    retentionMs: 100,
    tombstoneRetentionMs: 200,
  });
  const { staged } = await waitForContinuationApprovals(f, ["retained-command"]);
  clock += 101;

  await assert.rejects(() => f.service.sweep(), /approval cleanup unavailable/);
  const tombstone = (await f.records.get(staged.id))!;
  assert.equal(tombstone.state, "expired");
  assert.equal(tombstone.body, "This draft approval expired.");
  assert.doesNotMatch(JSON.stringify(await f.service.get(staged.id)), /alex@example\.com|Ready to launch|Launch/);
  assert.ok(
    (await f.deliveries.pending("slack")).some(
      (delivery) => delivery.destination.messageApproval?.version === tombstone.version,
    ),
  );
  await f.service.acknowledgeSlackMessage(staged.id, tombstone.version, "C1", "redacted-cleanup-card");
  clock = tombstone.purgeAt!;
  await assert.rejects(() => f.service.sweep(), /approval cleanup unavailable/);
  assert.deepEqual((await f.records.get(staged.id))?.continuationApprovalIds, ["retained-command"]);

  cleanupAvailable = true;
  await f.createService().recover();

  assert.equal(await approvals.get("retained-command"), null);
  assert.equal(await f.records.get(staged.id), null);
});

test("approval reconciliation follows the canonical run winner in terminal races", async () => {
  let clock = 1000;
  const expiring = await fixture({ now: () => clock, retentionMs: 100 });
  const expiringDraft = await expiring.stage();
  await expiring.service.decide({
    id: expiringDraft.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  const expiringRun = (await expiring.runs.list())[0]!;
  const expiringBinding = expiringRun.request.messageApprovalContinuation!;
  const expiringClaim = await claimRun(expiring.runs, expiringRun.id);
  assert.ok(await expiring.service.admitContinuation(expiringBinding, expiringClaim));
  clock += 101;
  await Promise.all([
    expiring.service.sweep(),
    expiring.runs.complete(expiringRun.id, expiringClaim.leaseToken, { status: "ok" }),
  ]);
  await expiring.service.reconcileContinuation(expiringBinding, expiringRun.id);
  const expireWinner = (await expiring.records.get(expiringDraft.id))!;
  assert.ok(expireWinner.state === "expired" || expireWinner.continuationStatus === "completed");
  if (expireWinner.state === "expired") assert.equal(expireWinner.continuationStatus, undefined);

  const failing = await fixture();
  const failingDraft = await failing.stage();
  await failing.service.decide({
    id: failingDraft.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  const failingRun = (await failing.runs.list())[0]!;
  const failingBinding = failingRun.request.messageApprovalContinuation!;
  const failingClaim = await claimRun(failing.runs, failingRun.id);
  assert.ok(await failing.service.admitContinuation(failingBinding, failingClaim));
  await Promise.all([
    failing.runs.fail(failingRun.id, failingClaim.leaseToken, "failed concurrently", { retry: false }),
    failing.runs.complete(failingRun.id, failingClaim.leaseToken, { status: "ok" }),
  ]);
  await failing.service.reconcileContinuation(failingBinding, failingRun.id);
  const canonical = await failing.runs.get(failingRun.id);
  const failWinner = (await failing.records.get(failingDraft.id))!;
  assert.equal(failWinner.continuationStatus, canonical?.status === "done" ? "completed" : "failed");
});

test("reject is terminal and never enqueues a continuation", async () => {
  const f = await fixture();
  const staged = await f.stage();
  const result = await f.service.decide({
    id: staged.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "reject",
  });
  assert.equal(result.ok && result.record.state, "rejected");
  await f.service.recover();
  assert.equal((await f.runs.list()).length, 0);
  assert.equal((await f.records.get(staged.id))?.continuationRunId, undefined);
});

test("inactive actors, deleted sessions, revoked scope, and terminal enqueue failures become failed without replacement sessions", async () => {
  const inactive = await fixture();
  const inactiveView = await inactive.stage();
  const inactiveRecord = (await inactive.records.get(inactiveView.id))!;
  await inactive.records.put(inactiveView.id, {
    ...inactiveRecord,
    state: "approved",
    version: 2,
    continuationBindingId: "deleted-binding",
    approvedSnapshot: {
      recipient: inactiveRecord.recipient,
      subject: inactiveRecord.subject,
      body: inactiveRecord.body,
      version: 2,
    },
  });
  inactive.active.value = false;
  await inactive.service.recover();
  assert.equal((await inactive.records.get(inactiveView.id))?.state, "failed");

  const deleted = await fixture();
  const deletedView = await deleted.stage();
  const deletedRecord = (await deleted.records.get(deletedView.id))!;
  await deleted.records.put(deletedView.id, {
    ...deletedRecord,
    state: "approved",
    version: 2,
    continuationBindingId: "revoked-binding",
    approvedSnapshot: {
      recipient: deletedRecord.recipient,
      subject: deletedRecord.subject,
      body: deletedRecord.body,
      version: 2,
    },
  });
  await deleted.sessions.deleteSession(deleted.session.id);
  await deleted.service.recover();
  assert.equal((await deleted.records.get(deletedView.id))?.state, "failed");
  assert.equal(await deleted.sessions.getByThread(deleted.conversation.threadRef), null);

  const revoked = await fixture();
  const revokedView = await revoked.stage();
  const revokedRecord = (await revoked.records.get(revokedView.id))!;
  await revoked.records.put(revokedView.id, {
    ...revokedRecord,
    state: "approved",
    version: 2,
    approvedSnapshot: {
      recipient: revokedRecord.recipient,
      subject: revokedRecord.subject,
      body: revokedRecord.body,
      version: 2,
    },
  });
  revoked.authorized.value = false;
  await revoked.service.recover();
  assert.equal((await revoked.records.get(revokedView.id))?.state, "failed");

  const failingRunStore = {
    ...createMemoryRunStore().runs,
    async enqueue(): Promise<never> {
      throw new NonRetryableTurnError("terminal queue failure with private details");
    },
  } satisfies RunStore;
  const terminal = await fixture({ runs: failingRunStore });
  const terminalView = await terminal.stage();
  await terminal.service.decide({
    id: terminalView.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  const failed = await terminal.records.get(terminalView.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.continuationError, "The continuation run failed.");
});

test("a transient enqueue failure remains recoverable and converges to one run", async () => {
  const memoryRuns = createMemoryRunStore().runs;
  let fail = true;
  const flaky = {
    ...memoryRuns,
    async enqueue(input: Parameters<RunStore["enqueue"]>[0]) {
      if (fail) {
        fail = false;
        throw new Error("temporary database outage");
      }
      return memoryRuns.enqueue(input);
    },
  } satisfies RunStore;
  const f = await fixture({ runs: flaky });
  const staged = await f.stage();
  const approved = await f.service.decide({
    id: staged.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  assert.equal(approved.ok && approved.record.state, "approved");
  await f.createService().recover();
  assert.equal((await f.records.get(staged.id))?.state, "enqueued");
  assert.equal((await memoryRuns.list()).length, 1);
});

test("a committed approval returns success when post-commit card and continuation recovery fail", async () => {
  const durableDeliveries = createDeliveryStore();
  let failDelivery = false;
  const deliveries = {
    ...durableDeliveries,
    async enqueue(input: Parameters<DeliveryStore["enqueue"]>[0]) {
      if (failDelivery) throw new Error("delivery unavailable after commit");
      return durableDeliveries.enqueue(input);
    },
  } satisfies DeliveryStore;
  const runs = {
    ...createMemoryRunStore().runs,
    async enqueue(): Promise<never> {
      throw new Error("run queue unavailable after commit");
    },
  } satisfies RunStore;
  const f = await fixture({ deliveries, runs });
  const staged = await f.stage();
  failDelivery = true;
  const result = await f.service.decide({
    id: staged.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  assert.equal(result.ok, true);
  assert.equal((await f.records.get(staged.id))?.state, "approved");
});

test("canonical acting alias becoming inactive before enqueue blocks continuation", async () => {
  const active = { value: true };
  const durableDeliveries = createDeliveryStore();
  const deliveries = {
    ...durableDeliveries,
    async enqueue(input: Parameters<DeliveryStore["enqueue"]>[0]) {
      if (input.destination.messageApproval?.version === 2) active.value = false;
      return durableDeliveries.enqueue(input);
    },
  } satisfies DeliveryStore;
  const f = await fixture({
    active,
    deliveries,
    canonical: (id) => (id === "U1" || id === "alice@example.com" ? "alice@example.com" : null),
  });
  const staged = await f.stage();
  const result = await f.service.decide({ id: staged.id, version: 1, actorId: "U1", decision: "approve" });
  assert.equal(result.ok, true);
  assert.equal((await f.records.get(staged.id))?.state, "failed");
  assert.equal((await f.runs.list()).length, 0);
});

test("run admission refusal and terminal success reconcile accurate continuation states", async () => {
  const refused = await fixture();
  const refusedDraft = await refused.stage();
  await refused.service.decide({
    id: refusedDraft.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  const refusedRun = (await refused.runs.list())[0]!;
  const refusedClaim = await refused.runs.claimById(refusedRun.id, "worker", 1000);
  assert.ok(refusedClaim?.leaseToken);
  const refusedIdentity = {
    runId: refusedClaim.id,
    leaseToken: refusedClaim.leaseToken,
    attempt: refusedClaim.attempts,
  };
  assert.ok(await refused.service.admitContinuation(refusedRun.request.messageApprovalContinuation!, refusedIdentity));
  await refused.runs.complete(refusedRun.id, refusedClaim!.leaseToken!, {
    status: "refused",
    reason: "admission refused",
  });
  await refused.service.sweep();
  assert.equal((await refused.records.get(refusedDraft.id))?.continuationStatus, "failed");

  const completed = await fixture();
  const completedDraft = await completed.stage();
  await completed.service.decide({
    id: completedDraft.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  const completedRun = (await completed.runs.list())[0]!;
  const completedClaim = await completed.runs.claimById(completedRun.id, "worker", 1000);
  assert.ok(completedClaim?.leaseToken);
  const completedIdentity = {
    runId: completedClaim.id,
    leaseToken: completedClaim.leaseToken,
    attempt: completedClaim.attempts,
  };
  assert.ok(
    await completed.service.admitContinuation(completedRun.request.messageApprovalContinuation!, completedIdentity),
  );
  await completed.service.sweep();
  assert.equal((await completed.records.get(completedDraft.id))?.continuationStatus, "running");
  await completed.runs.complete(completedRun.id, completedClaim!.leaseToken!, { status: "ok" });
  await completed.service.sweep();
  assert.equal((await completed.records.get(completedDraft.id))?.continuationStatus, "completed");
});

test("a continuation is never repeated after its run later fails", async () => {
  const f = await fixture();
  const staged = await f.stage();
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const run = (await f.runs.list())[0]!;
  const claimed = await f.runs.claimById(run.id, "worker", 1000);
  assert.ok(claimed?.leaseToken);
  await f.runs.fail(run.id, claimed!.leaseToken!, "operation failed", { retry: false });
  await f.service.recover();
  await f.service.recover();
  assert.equal((await f.runs.list()).length, 1);
  assert.equal((await f.records.get(staged.id))?.continuationRunId, run.id);
});

test("continuation prompt approves only the exact draft and keeps normal authorization in force", () => {
  const prompt = messageApprovalContinuationPrompt({
    approvalId: "approval-1",
    approvalVersion: 2,
    bindingId: "binding-1",
    recipient: "alex@example.com",
    subject: "Launch",
    body: "Exact body",
  });
  assert.match(prompt, /approved the exact draft/);
  assert.match(prompt, /recipient, subject, and body values unchanged/);
  assert.match(prompt, /Normal tool authorization and policy remain in force/);
  assert.match(prompt, /does not authorize, guarantee, or report any operation or sending/);
  assert.match(prompt, /"body":"Exact body"/);
  assert.doesNotMatch(prompt, /operation was approved|message was sent|send authorization/i);
  const orchestrator = readFileSync(new URL("../src/core/orchestrator.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/api/routes/turns.ts", import.meta.url), "utf8");
  const userScopedRoutes = readFileSync(new URL("../src/api/user-scoped-routes.ts", import.meta.url), "utf8");
  const slackCoreClient = readFileSync(new URL("../src/api/slack-core-client.ts", import.meta.url), "utf8");
  const wiring = readFileSync(new URL("../src/wiring.ts", import.meta.url), "utf8");
  const surfaceTools = readFileSync(new URL("../src/core/orchestrator/surface-tools.ts", import.meta.url), "utf8");
  assert.match(orchestrator, /continuationInstruction/);
  assert.match(orchestrator, /const syntheticPrompt =\s*!!input\.messageApprovalContinuation/);
  assert.match(routes, /messageApprovalContinuation: _messageApprovalContinuation/);
  assert.doesNotMatch(routes, /\/v1\/message-approvals/);
  assert.doesNotMatch(userScopedRoutes, /\/v1\/message-approvals/);
  assert.doesNotMatch(slackCoreClient, /getMessageApproval|decideMessageApproval|editMessageApproval/);
  assert.match(wiring, /await messageApprovalSweeper\.stop\(\)/);
  assert.match(surfaceTools, /!input\.messageApprovalContinuation/);
});

test("every harness disables delegation definitions and task recording during message approval continuation", () => {
  const continuationInstruction = {
    kind: "message_approval" as const,
    hidden: true as const,
    value: {
      approvalId: "approval-1",
      approvalVersion: 2,
      bindingId: "binding-1",
      recipient: "alex@example.com",
      subject: "Launch",
      body: "Ready to launch",
    },
  };
  assert.equal(harnessDelegationAllowed({ readOnly: false, continuationInstruction }), false);
  assert.equal(harnessDelegationAllowed({ readOnly: false }), true);
  const claude = readFileSync(new URL("../src/harness/claude-harness.ts", import.meta.url), "utf8");
  const codex = readFileSync(new URL("../src/harness/codex-harness.ts", import.meta.url), "utf8");
  const opencode = readFileSync(new URL("../src/harness/opencode-harness.ts", import.meta.url), "utf8");
  const pi = readFileSync(new URL("../src/harness/pi-harness.ts", import.meta.url), "utf8");
  assert.match(claude, /const allowSubagents = harnessDelegationAllowed\(turn\)/);
  assert.match(claude, /allowSubagents && message\.type === "system" && message\.subtype === "task_started"/);
  assert.match(codex, /if \(!harnessDelegationAllowed\(state\.turn\)\) return/);
  assert.match(codex, /multi_agent: harnessDelegationAllowed\(turn\)/);
  assert.match(opencode, /if \(!harnessDelegationAllowed\(state\.turn\)\) return/);
  assert.match(opencode, /enabled\.task = harnessDelegationAllowed\(turn\)/);
  assert.match(pi, /noTools: "builtin"/);
  for (const source of [claude, codex, opencode, pi]) {
    assert.match(source, /privatePersistence/);
  }
});

test("continuation plaintext is active-only and absent after durable retention purge and a later turn", async () => {
  const continuation = {
    approvalId: "approval-1",
    approvalVersion: 2,
    bindingId: "binding-1",
    recipient: "alex@example.com",
    subject: "Launch",
    body: "Exact body",
  };
  const prompt = harnessTurnInputText({
    input: "",
    continuationInstruction: { kind: "message_approval", value: continuation, hidden: true },
  });
  assert.match(prompt, /"body":"Exact body"/);
  const harness = createMockHarness();
  const entries: any[] = [];
  const tape: any[] = [];
  const captures: any[] = [];
  const session = {
    id: "session-1",
    type: "dm",
    scopeId: "personal:alice@example.com",
    threadRef: "slack:C1:100.200",
    createdAt: 1,
  } as const;
  const run = (input: string, value?: typeof continuation) =>
    harness.turns.runTurn({
      session,
      input,
      ...(value
        ? { continuationInstruction: { kind: "message_approval" as const, value, hidden: true as const } }
        : {}),
      systemPrompt: "system",
      history: forModelContext(entries),
      tools: {} as never,
      emit: async (entry: any) => {
        const stored = {
          ...entry,
          sessionId: session.id,
          seq: entries.length + 1,
          parentSeq: entries.at(-1)?.seq ?? null,
          createdAt: entries.length + 1,
        };
        entries.push(stored);
        return stored;
      },
      tape: async (record: any) => void tape.push(record),
      scopeLabel: session.scopeId,
      orgScopeId: "org:test",
      recordModelCall() {},
      recordLlmRequest: async (record: any) => void captures.push(record),
    } as never);
  await run("", continuation);
  for (const durable of [entries, tape, captures]) {
    assert.doesNotMatch(JSON.stringify(durable), /alex@example\.com|Exact body|"subject":"Launch"/);
  }

  let clock = 1000;
  const f = await fixture({ now: () => clock, retentionMs: 100 });
  const staged = await f.stage(
    message({ recipient: continuation.recipient, subject: continuation.subject, body: continuation.body }),
  );
  clock += 101;
  await f.service.sweep();
  const expired = (await f.records.get(staged.id))!;
  await f.service.acknowledgeSlackMessage(expired.id, expired.version, "C1", "redacted");
  await f.service.sweep();
  assert.equal(await f.records.get(staged.id), null);

  await run("later turn");
  const later = JSON.stringify({
    history: forModelContext(entries),
    tape: filterTapeForAudience(tape, [{ id: "alice@example.com", type: "internal" }], session.scopeId, "org:test"),
    capture: captures.at(-1),
  });
  assert.doesNotMatch(later, /alex@example\.com|Exact body|"subject":"Launch"/);
});

test("production adapters omit hidden continuation provider records without inspecting their shape", () => {
  const continuation = {
    approvalId: "approval-1",
    approvalVersion: 2,
    bindingId: "binding-1",
    recipient: "alex@example.com",
    subject: "Launch",
    body: "Exact body",
  };
  const turn = {
    continuationInstruction: { kind: "message_approval" as const, value: continuation, hidden: true as const },
  };
  const prompt = messageApprovalContinuationPrompt(continuation);
  const persisted = harnessPersistedProviderRecord(turn, {
    role: "assistant",
    content: prompt,
    nested: {
      arguments: {
        to: continuation.recipient,
        subjectLine: continuation.subject,
        html: continuation.body,
      },
    },
  });
  assert.deepEqual(persisted, { payload: { omitted: true }, hidden: true });
  const ordinary = { role: "assistant", content: "Ordinary provider response" };
  assert.deepEqual(harnessPersistedProviderRecord({}, ordinary), {
    payload: ordinary,
    hidden: false,
  });
  for (const file of ["claude-harness.ts", "codex-harness.ts", "pi-harness.ts", "opencode-harness.ts"]) {
    const source = readFileSync(new URL(`../src/harness/${file}`, import.meta.url), "utf8");
    assert.match(source, /defineHarness/);
    assert.match(source, /harnessPersistedProviderRecord/);
    assert.match(source, /harnessCapturedPromptEnvelope/);
    assert.match(source, /messageApprovalAttempted/);
  }
  const sharedHarness = readFileSync(new URL("../src/harness/harness.ts", import.meta.url), "utf8");
  assert.match(sharedHarness, /if \(!turn\.messageApprovals \|\| !turn\.tools\.stageMessageApproval\)/);
  assert.match(sharedHarness, /payload: \{ omitted: true, hidden: true \}/);
  assert.match(sharedHarness, /promptEnvelope: \{ omitted: true \}/);
  assert.match(sharedHarness, /messageApprovalAttempted: true, messageApprovalStaged: true/);
});

test("attempted staging omits generated provider records without changing the trigger user message", () => {
  const draft = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name: "stage_message_approval",
        arguments: { recipient: "private@example.com", subject: "Private", body: "Private body" },
      },
    ],
  };
  assert.deepEqual(harnessPersistedProviderRecord({}, draft, { generated: true, messageApprovalAttempted: true }), {
    payload: { omitted: true },
    hidden: true,
  });
  const result = { role: "toolResult", content: [{ type: "text", text: "staged" }] };
  assert.deepEqual(harnessPersistedProviderRecord({}, result, { generated: true, messageApprovalAttempted: true }), {
    payload: { omitted: true },
    hidden: true,
  });
  const user = { role: "user", content: [{ type: "text", text: "Please draft a launch email" }] };
  assert.deepEqual(harnessPersistedProviderRecord({}, user, { generated: false, messageApprovalAttempted: true }), {
    payload: user,
    hidden: false,
  });
});

test("failed staging is opaque and terminal for shared and DM turns across failure sources", async () => {
  const draft = {
    title: "Private launch draft",
    recipient: "private@example.com",
    subject: "Private subject",
    body: "Private body",
  };
  for (const kind of ["channel", "dm"] as const) {
    for (const failure of ["service throw", "validation fail", "delivery failure"] as const) {
      const entries: any[] = [];
      const tape: any[] = [];
      const captures: any[] = [];
      const deltas: string[] = [];
      const deliveries: string[] = [];
      let stageCalls = 0;
      let laterCalls = 0;
      let fenceError: unknown;
      const harness = defineHarness(
        {
          id: "privacy-test",
          controlTransport: "mock",
          toolTransport: "mock",
          transcriptFormat: "mock",
          capabilities: new Set(),
        },
        {
          async runTurn(turn) {
            const user = await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
            turn.onTextBlockStart?.();
            turn.onDelta?.(`Reasoning about ${draft.recipient} ${draft.body}`);
            await turn.emit({
              type: "thinking",
              payload: { thinking: `Reasoning about ${draft.recipient} ${draft.body}` },
              scopeLabel: turn.scopeLabel,
            });
            await turn.emit({
              type: "assistant",
              payload: { text: `Draft for ${draft.recipient}: ${draft.body}` },
              scopeLabel: turn.scopeLabel,
            });
            await turn.tape?.({
              kind: "message",
              harness: "privacy-test",
              payload: { role: "assistant", tool: "stage_message_approval", arguments: draft },
              scopeLabel: turn.scopeLabel,
            });
            await turn.recordLlmRequest?.({
              turnSeq: user.seq,
              step: 0,
              model: "privacy-test",
              promptEnvelope: { messages: [{ role: "assistant", content: draft }] },
              truncated: false,
            });
            let stageResult: unknown;
            try {
              stageResult = await turn.tools.stageMessageApproval!(draft, "stage-call");
            } catch (error) {
              stageResult = error;
            }
            await turn.emit({
              type: "tool_call",
              payload: { tool: "stage_message_approval", arguments: draft },
              scopeLabel: turn.scopeLabel,
            });
            await turn.emit({
              type: "tool_result",
              payload: { tool: "stage_message_approval", result: stageResult },
              scopeLabel: turn.scopeLabel,
            });
            try {
              await turn.tools.history?.("later call");
            } catch (error) {
              fenceError = error;
            }
            await turn.emit({
              type: "assistant",
              payload: { text: `Echo ${draft.recipient} ${draft.body}` },
              scopeLabel: turn.scopeLabel,
            });
            turn.onDelta?.(`Echo ${draft.recipient} ${draft.body}`);
            return { reply: `Echo ${draft.recipient} ${draft.body}` };
          },
        },
      );
      const session = {
        id: `${kind}-${failure}`,
        type: kind,
        scopeId: kind === "dm" ? "personal:alice@example.com" : "channel:C-private",
        threadRef: kind === "dm" ? "slack:D-private:1" : "slack:C-private:1",
        createdAt: 1,
      } as const;
      const input: HarnessTurnInput = {
        session: session as HarnessTurnInput["session"],
        input: "Please prepare a draft",
        systemPrompt: "system",
        history: [],
        messageApprovals: true,
        tools: {
          async stageMessageApproval() {
            stageCalls += 1;
            if (failure === "delivery failure") return { ok: false, message: `${draft.recipient} ${draft.body}` };
            throw new Error(`${failure}: ${draft.recipient} ${draft.body}`);
          },
          async history() {
            laterCalls += 1;
            return [];
          },
        } as never,
        emit: async (entry) => {
          const stored = {
            ...entry,
            sessionId: session.id,
            seq: entries.length + 1,
            parentSeq: entries.at(-1)?.seq ?? null,
            createdAt: entries.length + 1,
          };
          entries.push(stored);
          return stored as never;
        },
        tape: async (record) => void tape.push(record),
        scopeLabel: session.scopeId as never,
        orgScopeId: "org:test" as never,
        recordModelCall() {},
        recordLlmRequest: async (record) => void captures.push(record),
        onDelta: (chunk) => deltas.push(chunk),
        onTextBlockStart() {},
      };
      let runError: unknown;
      let result;
      try {
        result = await harness.turns.runTurn(input);
      } catch (error) {
        runError = error;
      }
      if (result?.reply) deliveries.push(result.reply);
      assert.equal(stageCalls, 1, `${kind} ${failure}`);
      assert.equal(laterCalls, 0, `${kind} ${failure}`);
      assert.equal((fenceError as Error).message, "Draft approval could not be staged.", `${kind} ${failure}`);
      assert.equal(runError, undefined, `${kind} ${failure}`);
      assert.equal(result?.messageApprovalAttempted, true, `${kind} ${failure}`);
      assert.equal(result?.messageApprovalStaged, undefined, `${kind} ${failure}`);
      assert.deepEqual(deliveries, ["Draft approval could not be staged."], `${kind} ${failure}`);
      assert.deepEqual(deltas, [], `${kind} ${failure}`);
      assert.doesNotMatch(
        JSON.stringify({ entries, tape, captures, runError, deliveries }),
        /private@example\.com|Private subject|Private body|Reasoning about|stage_message_approval/,
        `${kind} ${failure}`,
      );
      assert.equal(
        entries
          .filter((entry) => entry.type !== "user")
          .every((entry) => entry.payload.omitted === true && entry.payload.hidden === true),
        true,
        `${kind} ${failure}`,
      );
      const retry = await harness.turns.runTurn({ ...input, session: { ...input.session, id: `${session.id}-retry` } });
      assert.equal(retry.reply, "Draft approval could not be staged.", `${kind} ${failure}`);
      assert.equal(stageCalls, 2, `${kind} ${failure}`);
    }
  }
});

test("later shared context preserves prior user messages and never replays the staged draft", () => {
  const scopeId = "personal:alice@example.com";
  const rows = [
    {
      sessionId: "session-1",
      seq: 1,
      createdAt: 1,
      kind: "message" as const,
      scopeLabel: scopeId,
      harness: "pi",
      payload: { role: "user", content: [{ type: "text", text: "Please draft a launch email" }] },
    },
    {
      sessionId: "session-1",
      seq: 2,
      createdAt: 2,
      kind: "message" as const,
      scopeLabel: scopeId,
      harness: "pi",
      payload: { omitted: true },
      meta: { hidden: true },
    },
    {
      sessionId: "session-1",
      seq: 3,
      createdAt: 3,
      kind: "message" as const,
      scopeLabel: scopeId,
      harness: "pi",
      payload: { omitted: true },
      meta: { hidden: true },
    },
  ];
  const visible = filterTapeForAudience(rows, [{ id: "alice@example.com", type: "internal" }], scopeId, "org:test");
  const later = JSON.stringify(foldTape(visible));
  assert.match(later, /Please draft a launch email/);
  assert.doesNotMatch(later, /private@example\.com|Private body|stage_message_approval|omitted/);
});

test("hidden continuation omission is independent of provider field names and values", () => {
  const continuation = {
    approvalId: "approval-short",
    approvalVersion: 2,
    bindingId: "binding-short",
    recipient: "a",
    subject: "silent",
    body: "ok",
  };
  const turn = {
    continuationInstruction: { kind: "message_approval" as const, value: continuation, hidden: true as const },
  };
  const prompt = messageApprovalContinuationPrompt(continuation);
  const snapshot = JSON.stringify({ recipient: "a", subject: "silent", body: "ok" });
  const trigger = harnessPersistedProviderRecord(turn, {
    role: "user",
    content: prompt,
    snapshot,
    status: "silent",
    requestId: "a",
  });
  assert.deepEqual(trigger, { payload: { omitted: true }, hidden: true });
  assert.equal(JSON.stringify(trigger).includes(prompt), false);
  assert.equal(JSON.stringify(trigger).includes(snapshot), false);

  assert.deepEqual(
    harnessPersistedProviderRecord(turn, {
      role: "assistant",
      content: "An unrelated status is ok and a normal article remains readable.",
      recipient: "a",
      subject: "silent",
      body: "ok",
      status: "silent",
      requestId: "a",
      command: "ok",
      reason: "silent",
    }),
    { payload: { omitted: true }, hidden: true },
  );
});

test("older Slack delivery acknowledgements cannot replace a newer card pointer", async () => {
  const f = await fixture();
  const staged = await f.stage();
  assert.equal((await f.service.acknowledgeSlackMessage(staged.id, 1, "C1", "old")).winner, true);
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const current = (await f.records.get(staged.id))!;
  const newer = await f.service.acknowledgeSlackMessage(staged.id, current.version, "C1", "new");
  assert.equal(newer.winner, true);
  assert.deepEqual(newer.displaced, { channel: "C1", ts: "old" });
  const equal = await f.service.acknowledgeSlackMessage(staged.id, current.version, "C1", "equal-version-race");
  assert.equal(equal.winner, false);
  assert.deepEqual(equal.current, { channel: "C1", ts: "new" });
  assert.equal((await f.service.acknowledgeSlackMessage(staged.id, 1, "C1", "stale")).winner, false);
  assert.deepEqual((await f.records.get(staged.id))?.slackMessage, { channel: "C1", ts: "new" });
  assert.equal((await f.records.get(staged.id))?.cardVersion, current.version);
  assert.equal(await f.service.invalidateSlackMessage(staged.id, "C1", "wrong"), false);
  assert.equal(await f.service.invalidateSlackMessage(staged.id, "C1", "new"), true);
  await f.service.acknowledgeSlackMessage(staged.id, current.version, "C1", "replacement");
  assert.deepEqual((await f.records.get(staged.id))?.slackMessage, { channel: "C1", ts: "replacement" });
});

test("concurrent old-new and equal-version Slack acknowledgements converge on one current pointer", async () => {
  const f = await fixture();
  const staged = await f.stage();
  await f.service.acknowledgeSlackMessage(staged.id, 1, "C1", "old");
  await f.service.decide({ id: staged.id, version: 1, actorId: "alice@example.com", decision: "approve" });
  const version = (await f.records.get(staged.id))!.version;
  const outcomes = await Promise.all([
    f.service.acknowledgeSlackMessage(staged.id, version, "C1", "equal-a"),
    f.createService().acknowledgeSlackMessage(staged.id, version, "C1", "equal-b"),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.winner).length, 1);
  const winner = outcomes.find((outcome) => outcome.winner)!;
  assert.deepEqual(winner.displaced, { channel: "C1", ts: "old" });
  const pointer = (await f.records.get(staged.id))!.slackMessage;
  assert.ok(pointer?.ts === "equal-a" || pointer?.ts === "equal-b");
  assert.ok(outcomes.every((outcome) => outcome.current?.ts === pointer?.ts));
});

test("terminal records redact and then purge after bounded retention", async () => {
  let clock = 1000;
  const f = await fixture({ now: () => clock, retentionMs: 100 });
  const staged = await f.stage();
  const rejected = await f.service.decide({
    id: staged.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "reject",
  });
  assert.equal(rejected.ok, true);
  if (rejected.ok) {
    await f.service.acknowledgeSlackMessage(staged.id, rejected.record.version, "C1", "card");
  }
  clock += 101;
  await f.service.sweep();
  const expired = await f.records.get(staged.id);
  assert.equal(expired?.state, "expired");
  assert.equal(expired?.body, "This draft approval expired.");
  assert.doesNotMatch(JSON.stringify(expired), /alice@example\.com|Ready to launch|Launch/);
  await f.service.acknowledgeSlackMessage(staged.id, expired!.version, "C1", "redacted-card");
  await f.service.sweep();
  assert.equal(await f.records.get(staged.id), null);
  assert.equal((await f.runs.list()).length, 0);
});

test("abandoned pending and approved drafts expire", async () => {
  let clock = 1000;
  const pending = await fixture({ now: () => clock, retentionMs: 100 });
  const pendingDraft = await pending.stage();
  clock += 101;
  await pending.service.sweep();
  assert.equal((await pending.records.get(pendingDraft.id))?.state, "expired");

  const unavailableRuns = {
    ...createMemoryRunStore().runs,
    async enqueue(): Promise<never> {
      throw new Error("temporarily unavailable");
    },
  } satisfies RunStore;
  clock = 1000;
  const approved = await fixture({ now: () => clock, retentionMs: 100, runs: unavailableRuns });
  const approvedDraft = await approved.stage();
  await approved.service.decide({
    id: approvedDraft.id,
    version: 1,
    actorId: "alice@example.com",
    decision: "approve",
  });
  clock += 101;
  await approved.service.sweep();
  assert.equal((await approved.records.get(approvedDraft.id))?.state, "expired");
});

test("an expired redacted tombstone survives unavailable Slack and purges only after recovery acknowledgement", async () => {
  let clock = 1000;
  let available = true;
  const durable = createDeliveryStore();
  const deliveries = {
    ...durable,
    async enqueue(input: Parameters<DeliveryStore["enqueue"]>[0]) {
      if (!available) throw new Error("Slack delivery unavailable");
      return durable.enqueue(input);
    },
  } satisfies DeliveryStore;
  const f = await fixture({ now: () => clock, retentionMs: 100, deliveries });
  const staged = await f.stage();
  available = false;
  clock += 101;
  await f.service.sweep();
  const tombstone = (await f.records.get(staged.id))!;
  assert.equal(tombstone.state, "expired");
  assert.notEqual(tombstone.cardDeliveryVersion, tombstone.version);
  await f.service.sweep();
  assert.ok(await f.records.get(staged.id));
  available = true;
  await f.createService().recover();
  const redactedDelivery = (await durable.pending("slack")).find(
    (delivery) => delivery.destination.messageApproval?.version === tombstone.version,
  );
  assert.ok(redactedDelivery);
  await f.service.acknowledgeSlackMessage(staged.id, tombstone.version, "C1", "redacted");
  await f.service.sweep();
  assert.equal(await f.records.get(staged.id), null);
});

test("an expired redacted tombstone purges at its hard deadline without another Slack delivery", async () => {
  let clock = 1000;
  let enqueueAttempts = 0;
  let available = true;
  const durable = createDeliveryStore();
  const deliveries = {
    ...durable,
    async enqueue(input: Parameters<DeliveryStore["enqueue"]>[0]) {
      enqueueAttempts += 1;
      if (!available) throw new Error("Slack delivery unavailable");
      return durable.enqueue(input);
    },
  } satisfies DeliveryStore;
  const f = await fixture({
    now: () => clock,
    retentionMs: 100,
    tombstoneRetentionMs: 200,
    deliveries,
  });
  const staged = await f.stage();
  available = false;
  clock += 101;
  await f.service.sweep();
  const tombstone = (await f.records.get(staged.id))!;
  assert.equal(tombstone.state, "expired");
  assert.equal(tombstone.purgeAt, 1301);
  clock = 1300;
  await f.service.sweep();
  assert.ok(await f.records.get(staged.id));
  clock = 1301;
  const attemptsAtDeadline = enqueueAttempts;
  await f.service.sweep();
  await f.service.sweep();
  assert.equal(await f.records.get(staged.id), null);
  assert.equal(enqueueAttempts, attemptsAtDeadline);
  assert.equal(
    (await durable.pending("slack")).some(
      (delivery) => delivery.destination.messageApproval?.version === tombstone.version,
    ),
    false,
  );
});
