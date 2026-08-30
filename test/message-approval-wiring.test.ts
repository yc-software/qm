import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMessageApprovalService, type MessageApprovalRecord } from "../src/core/message-approval.ts";
import { replayableRequest } from "../src/core/orchestrator/turn-helpers.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("buildApp wires message approval continuation admission through the worker orchestrator", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "message-approval-wiring-")) }));
  const principalId = "U1";
  const scope = scopeId("personal", principalId);
  const conversation = {
    kind: "dm" as const,
    threadRef: "slack:D1:100.200",
    audience: [{ id: principalId, type: "internal" as const }],
  };
  await built.directory.replace([{ principalId, displayName: "Alice", type: "internal" }]);
  const session = await built.sessions.getOrCreateByThread(conversation.threadRef, "dm", scope, undefined, "slack");
  built.runtime.start();
  try {
    const staged = await built.messageApprovals.stage({
      idempotencyKey: "wiring-stage",
      actor: { id: principalId, type: "internal", displayName: "Alice" },
      sessionId: session.id,
      scopeId: scope,
      surface: "slack",
      conversation,
      originDestination: { type: "slack", target: "D1:100.200" },
      message: {
        title: "Send launch note",
        recipient: "alex@example.com",
        subject: "Launch",
        body: "Ready to launch",
      },
    });
    const approved = await built.messageApprovals.decide({
      id: staged.id,
      version: staged.version,
      actorId: principalId,
      decision: "approve",
    });
    assert.equal(approved.ok, true);
    const continuation = (await built.runs.list()).find((run) => run.request.messageApprovalContinuation);
    assert.ok(continuation);
    assert.equal(continuation.request.runLeaseToken, undefined);
    const completed = await built.runs.waitFor(continuation.id, 5_000);
    assert.equal(completed.result?.status, "silent", completed.result?.reason);
    let continuationStatus = (await built.messageApprovals.get(staged.id))?.continuationStatus;
    for (let i = 0; i < 20 && continuationStatus !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continuationStatus = (await built.messageApprovals.get(staged.id))?.continuationStatus;
    }
    assert.equal(continuationStatus, "completed");
  } finally {
    await built.runtime.stop();
  }
});

test("short draft values preserve nested approval reconciliation and unblock the thread", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "message-approval-short-values-")) }));
  const principalId = "U-short";
  const scope = scopeId("personal", principalId);
  const conversation = {
    kind: "dm" as const,
    threadRef: "slack:D-short:100.200",
    audience: [{ id: principalId, type: "internal" as const }],
  };
  await built.directory.replace([{ principalId, displayName: "Alice", type: "internal" }]);
  const session = await built.sessions.getOrCreateByThread(conversation.threadRef, "dm", scope, undefined, "slack");
  try {
    const staged = await built.messageApprovals.stage({
      idempotencyKey: "short-values-stage",
      actor: { id: principalId, type: "internal" },
      sessionId: session.id,
      scopeId: scope,
      surface: "slack",
      conversation,
      originDestination: { type: "slack", target: "D-short:100.200" },
      message: { title: "Short values", recipient: "a", subject: "silent", body: "ok" },
    });
    await built.messageApprovals.decide({
      id: staged.id,
      version: staged.version,
      actorId: principalId,
      decision: "approve",
    });
    const continuationRun = (await built.runs.list()).find((run) => run.request.messageApprovalContinuation)!;
    const claim = await built.runs.claimById(continuationRun.id, "short-values-worker", 1000);
    assert.ok(claim?.leaseToken);
    const binding = continuationRun.request.messageApprovalContinuation!;
    assert.ok(
      await built.messageApprovals.admitContinuation(binding, {
        runId: claim.id,
        leaseToken: claim.leaseToken,
        attempt: claim.attempts,
      }),
    );
    await built.approvals.put("a", {
      sessionId: session.id,
      command: "ok",
      createdAt: Date.now(),
      reason: "silent",
      request: replayableRequest(continuationRun.request),
      blocksInput: true,
    });
    assert.equal(
      await built.runs.complete(continuationRun.id, claim.leaseToken, {
        status: "pending_approval",
        pendingApprovals: [{ requestId: "a", command: "ok", reason: "silent" }],
      }),
      true,
    );
    await built.messageApprovals.reconcileContinuation(binding, continuationRun.id);

    const humanTurn = {
      surface: "slack",
      actor: { externalId: principalId },
      conversation: { kind: "dm" as const, threadRef: conversation.threadRef },
      text: "new work",
    };
    const blocked = await built.app.turn(humanTurn);
    assert.equal(blocked.status, "pending_approval");
    assert.deepEqual(blocked.pendingApprovals?.[0], {
      requestId: "a",
      command: "ok",
      reason: "silent",
      blocksInput: true,
    });

    const resolved = await built.app.turn({
      ...continuationRun.request,
      surface: continuationRun.request.surface ?? "slack",
      actor: { externalId: principalId },
      conversation: { kind: "dm", threadRef: conversation.threadRef },
      approval: { requestId: "a", approved: true },
    });
    assert.equal(resolved.status, "silent", resolved.reason);
    assert.equal((await built.messageApprovals.get(staged.id))?.continuationStatus, "completed");
    assert.equal(await built.approvals.get("a"), null);
    assert.notEqual((await built.app.turn(humanTurn)).status, "pending_approval");
  } finally {
    await built.runtime.stop();
  }
});

test("waiting message approval expiry removes the App.turn blocker and allows a new turn", async () => {
  let clock = 1000;
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "message-approval-expiry-")) }));
  const principalId = "U-expiry";
  const scope = scopeId("personal", principalId);
  const conversation = {
    kind: "dm" as const,
    threadRef: "slack:D-expiry:100.200",
    audience: [{ id: principalId, type: "internal" as const }],
  };
  await built.directory.replace([{ principalId, displayName: "Alice", type: "internal" }]);
  const session = await built.sessions.getOrCreateByThread(conversation.threadRef, "dm", scope, undefined, "slack");
  const records = createMemoryMap<MessageApprovalRecord>();
  const service = createMessageApprovalService({
    records,
    approvals: built.approvals,
    auditLog: built.auditLog,
    deliveries: built.deliveries,
    runs: built.runs,
    sessions: built.sessions,
    now: () => clock,
    retentionMs: 100,
    resolveCanonicalPrincipal: async (id) => id,
    isActiveInternalPrincipal: async () => true,
    isAuthorizedForScope: async () => true,
  });
  try {
    const staged = await service.stage({
      idempotencyKey: "app-turn-expiry",
      actor: { id: principalId, type: "internal" },
      sessionId: session.id,
      scopeId: scope,
      surface: "slack",
      conversation,
      originDestination: { type: "slack", target: "D-expiry:100.200" },
      message: {
        title: "Send launch note",
        recipient: "alex@example.com",
        subject: "Launch",
        body: "Ready to launch",
      },
    });
    await service.decide({ id: staged.id, version: 1, actorId: principalId, decision: "approve" });
    const run = (await built.runs.list()).find((candidate) => candidate.request.messageApprovalContinuation)!;
    const claim = await built.runs.claimById(run.id, "expiry-test", 1000);
    assert.ok(claim?.leaseToken);
    const binding = run.request.messageApprovalContinuation!;
    assert.ok(
      await service.admitContinuation(binding, {
        runId: claim.id,
        leaseToken: claim.leaseToken,
        attempt: claim.attempts,
      }),
    );
    await built.approvals.put("app-turn-blocker", {
      sessionId: session.id,
      command: "mail_send",
      createdAt: clock,
      reason: "approval",
      request: replayableRequest(run.request),
      blocksInput: true,
    });
    assert.equal(
      await built.runs.complete(run.id, claim.leaseToken, {
        status: "pending_approval",
        pendingApprovals: [{ requestId: "app-turn-blocker", command: "mail_send", reason: "approval" }],
      }),
      true,
    );
    await service.reconcileContinuation(binding, run.id);
    const turn = {
      surface: "slack",
      actor: { externalId: principalId },
      conversation: { kind: "dm" as const, threadRef: conversation.threadRef },
      text: "start a new turn",
    };
    assert.equal((await built.app.turn(turn)).status, "pending_approval");

    clock += 101;
    await service.sweep();

    assert.equal(await built.approvals.get("app-turn-blocker"), null);
    assert.notEqual((await built.app.turn(turn)).status, "pending_approval");
  } finally {
    await built.runtime.stop();
  }
});
