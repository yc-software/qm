import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorDeps, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { defineHarness } from "../src/harness/harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { scopeId, type Conversation, type PendingApprovalRecord, type Principal } from "../src/types.ts";
import type { HarnessTurnResult } from "../src/harness/harness.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMetricsSink } from "../src/admin/metrics-sink.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = {
  kind: "channel",
  threadRef: "ch:C1:bookkeeping",
  channelRef: "C1",
  audience: [actor],
};
scopeId("channel", "C1");

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the bookkeeping tests must not provision a sandbox");
  };
  return {
    profile: { backend: "fake", writablePersistence: "snapshot_to_workspace", processSessions: false },
    provision: unreached as never,
    run: unreached as never,
    readFile: unreached as never,
    writeFile: unreached as never,
    writeFileBytes: unreached as never,
    readFileBytes: unreached as never,
    listDir: unreached as never,
    removeDir: unreached as never,
    teardown: unreached as never,
  };
}

function buildScenario(
  turnResult?: Partial<HarnessTurnResult>,
  options: {
    conversation?: Conversation;
    managedGroups?: NonNullable<OrchestratorDeps["managedGroups"]>;
  } = {},
) {
  const posted: string[] = [];
  const harness = defineHarness(
    {
      id: "pi",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "pi",
      capabilities: new Set(),
    },
    {
      async runTurn(turn) {
        const userEntry = await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        await turn.tape?.({
          kind: "message",
          harness: "pi",
          payload: { role: "user", content: [{ type: "text", text: turn.input }], timestamp: Date.now() },
          scopeLabel: turn.scopeLabel,
          entrySeq: userEntry.seq,
          meta: { bareText: turn.input },
        });
        if (turn.input.startsWith("quarantine then stop")) {
          await turn.screenToolResult?.({
            tool: "execute",
            result: "!security-risk quarantined output",
            unscreenable: false,
            provenance: "external",
          });
        }
        if (turn.surfaceTools && turn.input.startsWith("post then fail bookkeeping")) {
          const result = await turn.tools.post("mid-turn surface post");
          posted.push(result.ok ? "ok" : "failed");
        }
        const reply = turn.input.startsWith("post then fail bookkeeping") ? "" : "done";
        await turn.tape?.({
          kind: "message",
          harness: "pi",
          payload: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: Date.now() },
          scopeLabel: turn.scopeLabel,
        });
        const finalEntry = await turn.emit({
          type: "assistant",
          payload: { text: reply },
          scopeLabel: turn.scopeLabel,
        });
        await turn.tape?.({
          kind: "annotation",
          payload: { subturnEnd: true },
          scopeLabel: turn.scopeLabel,
          entrySeq: finalEntry.seq,
        });
        return { reply, modelCalls: 1, ...turnResult };
      },
      async screenSecurity({ payload }) {
        return payload.includes("!security-risk")
          ? { decision: "strict" as const, reason: "test quarantine" }
          : { decision: "auto" as const };
      },
    },
  );
  const sessions = createMemorySessionStore();
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "bookkeeping-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "bookkeeping-deploy"),
    auditLog,
    acl,
  });
  const deliveries = createDeliveryStore();
  const approvals = createMemoryMap<PendingApprovalRecord>();
  const metrics = createMetricsSink();
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, createMemoryConfigStore(ORG), acl),
    sessionTapeMode: "serve",
    sessions,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    memoryPolicy: { recall: "off", capture: "off" },
    deploy,
    acl,
    deliveries,
    approvals,
    metrics,
    ...(options.managedGroups ? { managedGroups: options.managedGroups } : {}),
  });
  const input = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "slack",
    actor,
    conversation: options.conversation ?? conversation,
    origin: { kind: "direct" },
    text,
    ...extra,
  });
  return { orchestrator, sessions, deliveries, posted, approvals, metrics, auditLog, input };
}

test("a turn-end coverage append failure after a surface post fails loudly but non-retryably", async () => {
  const { orchestrator, sessions, posted, input } = buildScenario();
  await orchestrator.handleTurn(input("prime"));
  const appendTape = sessions.appendTape.bind(sessions);
  sessions.appendTape = async (lease, rec) => {
    if (rec.kind === "annotation" && (rec.payload as { turnEnd?: unknown }).turnEnd === true) {
      throw new Error("bookkeeping write refused");
    }
    return appendTape(lease, rec);
  };
  const turn = orchestrator.handleTurn(
    input("post then fail bookkeeping", {
      addressed: true,
      surfaceTools: true,
      deliveryTarget: "slack:C1:bookkeeping",
    }),
  );
  await assert.rejects(turn, (err: unknown) => {
    assert.ok(err instanceof NonRetryableTurnError, "the worker must not re-execute a turn whose effects landed");
    assert.match((err as Error).message, /coverage append failed/);
    return true;
  });
  assert.deepEqual(posted, ["ok"], "the surface post landed exactly once");
  const session = (await sessions.getByThread(conversation.threadRef))!;
  const latest = await sessions.latestEntrySeq(session.id);
  assert.ok((await sessions.tapeCoverage(session.id)) < latest, "coverage stays withheld for the heal to cover");
});

test("a pre-effect tape write failure stays retryable turn-fatal", async () => {
  const { orchestrator, sessions, input } = buildScenario();
  await orchestrator.handleTurn(input("prime"));
  const appendTape = sessions.appendTape.bind(sessions);
  sessions.appendTape = async (lease, rec) => {
    if (rec.kind === "message" && (rec.payload as { role?: string }).role === "assistant") {
      throw new Error("mid-step tape write refused");
    }
    return appendTape(lease, rec);
  };
  await assert.rejects(orchestrator.handleTurn(input("plain question")), (err: unknown) => {
    assert.ok(!(err instanceof NonRetryableTurnError), "pre-effect failures keep the retry path");
    assert.match((err as Error).message, /mid-step tape write refused/);
    return true;
  });
});

test("a cancel-stopped turn still persists and surfaces its pending approvals", async () => {
  const { orchestrator, metrics, input } = buildScenario({
    reply: "",
    stopped: true,
    pendingApprovals: [{ command: "rm -rf /srv/data", reason: "destructive command" }],
  });
  const controller = new AbortController();
  controller.abort();
  const result = await orchestrator.handleTurn(
    input("wipe the data dir", { cancel: controller.signal, runId: "cancelled-sdk-approval" }),
  );
  const approval = result.pendingApprovals?.[0];
  assert.deepEqual(result, {
    status: "pending_approval",
    sessionId: result.sessionId,
    pendingApprovals: [
      {
        requestId: approval?.requestId,
        command: "rm -rf /srv/data",
        reason: "destructive command",
        blocksInput: true,
      },
    ],
  });
  const rows = await metrics.list({ sessionId: result.sessionId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "paused");
  assert.equal(rows[0]!.runId, "cancelled-sdk-approval");
});

test("a cancel-stopped completion records one silent metric row", async () => {
  const { orchestrator, metrics, input } = buildScenario({ reply: "", stopped: true });
  const controller = new AbortController();
  controller.abort();
  const result = await orchestrator.handleTurn(
    input("stop this turn", { cancel: controller.signal, runId: "cancelled-metric" }),
  );
  assert.deepEqual(result, { status: "silent", sessionId: result.sessionId, stopped: true });
  const rows = await metrics.list({ sessionId: result.sessionId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "silent");
  assert.equal(rows[0]!.runId, "cancelled-metric");
});

test("cancelled wins over explicit and no-update poll silence while retaining stopped", async () => {
  const { orchestrator, metrics, input } = buildScenario({
    reply: "[no-update]",
    stopped: true,
    silent: true,
  });
  const controller = new AbortController();
  controller.abort();
  const result = await orchestrator.handleTurn(
    input("cancelled poll", {
      surface: "monitor",
      origin: { kind: "automation" },
      cancel: controller.signal,
      runId: "cancelled-poll-priority",
    }),
  );
  assert.deepEqual(result, { status: "silent", sessionId: result.sessionId, stopped: true });
  const rows = await metrics.list({ sessionId: result.sessionId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "silent");
  assert.equal(rows[0]!.runId, "cancelled-poll-priority");
});

test("cancelled ignores a quarantine-only release approval but not an SDK approval", async () => {
  const { orchestrator, approvals, metrics, auditLog, input } = buildScenario({ reply: "", stopped: true });
  const controller = new AbortController();
  controller.abort();
  const result = await orchestrator.handleTurn(
    input("quarantine then stop", { cancel: controller.signal, runId: "cancelled-quarantine-priority" }),
  );
  assert.deepEqual(result, { status: "silent", sessionId: result.sessionId, stopped: true });
  assert.equal(
    (await auditLog.events()).filter((event) => event.action === "security_posture.tool_result_quarantine").length,
    1,
  );
  assert.deepEqual(await approvals.all(), []);
  const rows = await metrics.list({ sessionId: result.sessionId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "silent");
  assert.equal(rows[0]!.runId, "cancelled-quarantine-priority");
});

test("legacy truthy silent and surface-tools values keep their completion semantics", async () => {
  const poll = buildScenario({ reply: "", silent: "legacy" as never });
  const pollResult = await poll.orchestrator.handleTurn(
    poll.input("legacy silent poll", {
      surface: "monitor",
      origin: { kind: "automation" },
      runId: "legacy-truthy-silent",
    }),
  );
  assert.deepEqual(pollResult, { status: "silent", sessionId: pollResult.sessionId });
  const pollRows = await poll.metrics.list({ sessionId: pollResult.sessionId });
  assert.equal(pollRows.length, 1);
  assert.equal(pollRows[0]!.status, "silent");

  const surface = buildScenario({ reply: "done" });
  const surfaceResult = await surface.orchestrator.handleTurn(
    surface.input("legacy surface tools", {
      runId: "legacy-truthy-surface",
      surfaceTools: "legacy" as never,
      deliveryTarget: "slack:C1:bookkeeping",
    }),
  );
  assert.deepEqual(surfaceResult, { status: "silent", sessionId: surfaceResult.sessionId });
  const surfaceRows = await surface.metrics.list({ sessionId: surfaceResult.sessionId });
  assert.equal(surfaceRows.length, 1);
  assert.equal(surfaceRows[0]!.status, "silent");
});

test("a stopped surface-tools completion keeps its stopped flag and records one silent metric row", async () => {
  const { orchestrator, metrics, input } = buildScenario({ reply: "done", stopped: true });
  const result = await orchestrator.handleTurn(
    input("surface turn stopped", {
      runId: "surface-stopped-metric",
      surfaceTools: true,
      deliveryTarget: "slack:C1:bookkeeping",
    }),
  );
  assert.deepEqual(result, { status: "silent", sessionId: result.sessionId, stopped: true });
  const rows = await metrics.list({ sessionId: result.sessionId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "silent");
  assert.equal(rows[0]!.runId, "surface-stopped-metric");
});

test("an approval write failure leaves the completed harness metric at its baseline emission point", async () => {
  const { orchestrator, approvals, metrics, input } = buildScenario({
    reply: "",
    pendingApprovals: [{ command: "gated-check", reason: "requires approval" }],
    pausedOnApproval: true,
  });
  approvals.put = async () => {
    throw new Error("approval write refused");
  };
  await assert.rejects(
    orchestrator.handleTurn(input("pause for approval", { runId: "approval-write-metric" })),
    /approval write refused/,
  );
  const rows = await metrics.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "paused");
  assert.equal(rows[0]!.runId, "approval-write-metric");
});

test("a final approval roster mismatch leaves the completed harness metric at its baseline emission point", async () => {
  let approvalWritten = false;
  const managedGroups: NonNullable<OrchestratorDeps["managedGroups"]> = {
    recognizes: () => true,
    members: async () => ["U1"],
    version: async () => "roster-v1",
    withVersion: async (_groupId, _version, fn) => {
      const value = await fn();
      return approvalWritten ? undefined : value;
    },
    slackChannel: async () => undefined,
  };
  const groupConversation: Conversation = {
    kind: "group",
    threadRef: "group:metric-roster",
    channelRef: "web-project-metric-roster",
    audience: [actor],
  };
  const { orchestrator, approvals, metrics, input } = buildScenario(
    {
      reply: "",
      pendingApprovals: [{ command: "gated-check", reason: "requires approval" }],
      pausedOnApproval: true,
    },
    { conversation: groupConversation, managedGroups },
  );
  const put = approvals.put.bind(approvals);
  approvals.put = async (id, value) => {
    await put(id, value);
    approvalWritten = true;
  };
  const result = await orchestrator.handleTurn(
    input("pause for roster approval", {
      runId: "roster-mismatch-metric",
      sessionParticipantIds: ["U1"],
      scopeVersion: "roster-v1",
    }),
  );
  assert.equal(result.status, "refused");
  assert.match(result.reason ?? "", /project membership changed/);
  const rows = await metrics.list({ sessionId: result.sessionId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "paused");
  assert.equal(rows[0]!.runId, "roster-mismatch-metric");
});

test("an overheard import failure aborts the batch instead of skipping one message", async () => {
  const { orchestrator, sessions, input } = buildScenario();
  await orchestrator.handleTurn(input("prime"));
  const append = sessions.append.bind(sessions);
  sessions.append = async (lease, entry) => {
    const payload = entry.payload as { overheard?: unknown; ts?: unknown } | null;
    if (payload?.overheard === true && payload.ts === "200.2") throw new Error("append refused");
    return append(lease, entry);
  };
  const result = await orchestrator.handleTurn(
    input("what did I miss?", {
      overheard: [
        { role: "user", name: "Ann", text: "first overheard", ts: "100.1" },
        { role: "user", name: "Bob", text: "second overheard", ts: "200.2" },
        { role: "user", name: "Cee", text: "third overheard", ts: "300.3" },
      ],
    }),
  );
  assert.equal(result.status, "ok");
  const session = (await sessions.getByThread(conversation.threadRef))!;
  const overheardTexts = (await sessions.getEntries(session.id))
    .filter((e) => (e.payload as { overheard?: unknown } | null)?.overheard === true)
    .map((e) => (e.payload as { text?: string }).text);
  assert.deepEqual(overheardTexts, ["first overheard"], "the batch stops at the failure; nothing lands out of order");
});
