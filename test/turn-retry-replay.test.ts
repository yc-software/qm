import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
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
import { scopeId, type Conversation, type Principal, type SessionEntry } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "web:U1:retry", audience: [actor] };
scopeId("personal", "U1");

const ASK = "where is that running?";

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the retry-replay tests must not provision a sandbox");
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

function buildScenario() {
  const turns: string[] = [];
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
        turns.push(turn.input);
        const userEntry = await turn.emit({
          type: "user",
          payload: { text: turn.input },
          scopeLabel: turn.scopeLabel,
        });
        await turn.tape?.({
          kind: "message",
          harness: "pi",
          payload: { role: "user", content: [{ type: "text", text: turn.input }], timestamp: Date.now() },
          scopeLabel: turn.scopeLabel,
          entrySeq: userEntry.seq,
          meta: { bareText: turn.input },
        });
        const reply = "it runs on this conversation's computer";
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
        return { reply, modelCalls: 1 };
      },
      async screenSecurity() {
        return { decision: "auto" as const };
      },
    },
  );
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "retry-replay-")));
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, createMemoryConfigStore(ORG), acl),
    sessionTapeMode: "serve",
    sessions,
    runs,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy: createDeployService({
      deployStore: createDeployStore(),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "retry-replay-deploy"),
      auditLog,
      acl,
    }),
    acl,
    deliveries: createDeliveryStore(),
  });
  const input = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "web",
    actor,
    conversation,
    origin: { kind: "human" },
    text,
    ...extra,
  });
  const asks = async (): Promise<SessionEntry[]> => {
    const session = (await sessions.getByThread(conversation.threadRef))!;
    return (await sessions.getEntries(session.id, { limit: 200 })).filter(
      (e) => e.type === "user" && String((e.payload as { text?: string }).text ?? "").startsWith(ASK),
    );
  };
  return { orchestrator, sessions, runs, turns, input, asks };
}

test("a retry replays the answer the previous attempt recorded instead of asking again", async () => {
  const { orchestrator, runs, turns, input, asks } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;

  const first = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 }));
  assert.equal(first.status, "ok");
  assert.equal((await asks()).length, 1, "the first attempt recorded the ask once");
  const boundary = (await runs.get(run.id))?.turnUserSeq;
  assert.equal(typeof boundary, "number", "the attempt recorded its turn boundary against the run");

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok", "the reaped run completes instead of re-answering");
  assert.equal(retry.reply, "it runs on this conversation's computer", "the recorded answer is replayed, not lost");
  assert.equal(retry.sourceUserSeq, boundary, "the replay points at the turn the answer belongs to");
  assert.equal(typeof retry.sourceAssistantEntrySeq, "number", "the replay names the recorded answer entry");
  assert.equal((await asks()).length, 1, "the ask is not appended a second time");
  assert.equal(turns.length, 1, "the model is not asked to answer twice");
  assert.equal((await runs.get(run.id))?.turnUserSeq, boundary, "the boundary is not moved by the retry");
});

test("a retry with no recorded boundary runs the turn, so a lost attempt never drops the ask", async () => {
  const { orchestrator, runs, turns, input, asks } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok", "an attempt that died before recording anything still answers");
  assert.equal((await asks()).length, 1);
  assert.equal(turns.length, 1);
});

test("a repeated identical ask in its own run is answered, not mistaken for a replay", async () => {
  const { orchestrator, runs, turns, input, asks } = buildScenario();
  const first = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await orchestrator.handleTurn(input(ASK, { runId: first.id, attempt: 1 }));

  const second = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const again = await orchestrator.handleTurn(input(ASK, { runId: second.id, attempt: 2 }));

  assert.equal(again.status, "ok", "a different run's retry is not silenced by the earlier answer");
  assert.equal((await asks()).length, 2);
  assert.equal(turns.length, 2);
});

test("a retry does not claim a later message's answer as its own", async () => {
  const { orchestrator, sessions, runs, turns, input, asks } = buildScenario();
  const mine = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", "personal:U1");
  const { lease } = await sessions.acquireLease(session.id);
  const boundary = await sessions.append(lease!, {
    type: "user",
    payload: { text: ASK },
    scopeLabel: session.scopeId,
  });
  await sessions.append(lease!, { type: "user", payload: { text: "a later ask" }, scopeLabel: session.scopeId });
  await sessions.append(lease!, {
    type: "assistant",
    payload: { text: "answering the later ask" },
    scopeLabel: session.scopeId,
  });
  await sessions.releaseLease(lease!);
  await runs.noteTurnUserSeq(mine.id, boundary.seq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: mine.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.notEqual(retry.reply, "answering the later ask", "the other turn's answer is not replayed as this one's");
  assert.equal(turns.length, 1, "the unanswered turn is resumed rather than silenced");
  assert.equal((await asks()).length, 1, "resuming does not append the ask again");
});

test("the replay does not need the session lease, so a busy session cannot requeue it again", async () => {
  const { orchestrator, sessions, runs, turns, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 }));

  const session = (await sessions.getByThread(conversation.threadRef))!;
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease, "something else now holds the session");
  try {
    const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
    assert.equal(retry.status, "ok", "the replay is not refused as session_busy");
    assert.equal(retry.reply, "it runs on this conversation's computer");
    assert.equal(turns.length, 1);
  } finally {
    await sessions.releaseLease(lease!);
  }
});

async function seedTurn(
  sessions: ReturnType<typeof buildScenario>["sessions"],
  entries: Array<{ type: "user" | "assistant" | "tool_call"; payload: Record<string, unknown> }>,
): Promise<number> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", "personal:U1");
  const { lease } = await sessions.acquireLease(session.id);
  let first = -1;
  try {
    for (const e of entries) {
      const appended = await sessions.append(lease!, { type: e.type, payload: e.payload, scopeLabel: session.scopeId });
      if (first < 0) first = appended.seq;
    }
  } finally {
    await sessions.releaseLease(lease!);
  }
  return first;
}

test("a steer mid-turn does not make an answered turn look unanswered", async () => {
  const { orchestrator, sessions, runs, turns, input, asks } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const marker = await seedTurn(sessions, [
    { type: "user", payload: { text: ASK } },
    { type: "tool_call", payload: { tool: "execute", callId: "c1", command: "ls" } },
    { type: "user", payload: { text: "also check the log", ts: "1", steered: true } },
    { type: "assistant", payload: { text: "checked both" } },
  ]);
  await runs.noteTurnUserSeq(run.id, marker);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.equal(retry.reply, "checked both", "the steered turn's own answer is replayed");
  assert.equal(turns.length, 0, "the model is not asked to answer the steered turn again");
  assert.equal((await asks()).length, 1, "the ask is not appended again");
});

test("a turn that recorded no reply replays as silent, not as an empty answer", async () => {
  const { orchestrator, sessions, runs, turns, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const marker = await seedTurn(sessions, [
    { type: "user", payload: { text: ASK } },
    { type: "assistant", payload: { text: "" } },
  ]);
  await runs.noteTurnUserSeq(run.id, marker);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "silent", "an empty reply must not surface as a turn with no response");
  assert.equal(retry.reply, undefined);
  assert.equal(turns.length, 0);
});
