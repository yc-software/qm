import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import type { ResumableToolCall } from "../src/core/turn-resume.ts";
import { INTERRUPTED_TOOL_RESULT } from "../src/harness/context-compaction.ts";
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
import { defineHarness, type HarnessTurnInput } from "../src/harness/harness.ts";
import { bridgedTools, resumeInterruptedToolCall } from "../src/harness/harness-shared.ts";
import type { ToolContextRef } from "../src/harness/agent-tools.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { scopeId, type Conversation, type Principal, type SessionEntry } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "./support/single-process.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "web:U1:resume", audience: [actor] };
const personal = scopeId("personal", "U1");
const ASK = "what did we decide about the budget?";

function historyToolContext(calls: string[]): ToolContext {
  return {
    async history(q: string) {
      calls.push(q);
      return [`user#3: the budget doc is in shared/q2.md (${q})`];
    },
  } as unknown as ToolContext;
}

function turnFor(
  history: SessionEntry[],
  call: ResumableToolCall | undefined,
  sink: Array<{ type: string; payload: unknown }>,
  tools: ToolContext,
): HarnessTurnInput {
  let seq = history.length + 10;
  return {
    session: { id: "s1" } as HarnessTurnInput["session"],
    input: "(system note: resumed)",
    systemPrompt: "BASE",
    history,
    tools,
    scopeLabel: personal,
    orgScopeId: scopeId("org", ORG),
    emit: async (entry) => {
      sink.push({ type: entry.type, payload: entry.payload });
      return { ...entry, sessionId: "s1", seq: seq++, parentSeq: null, createdAt: 1000 + seq } as SessionEntry;
    },
    recordModelCall: () => {},
    ...(call ? { resumeToolCall: call } : {}),
  };
}

const danglingCall: SessionEntry = {
  sessionId: "s1",
  seq: 2,
  parentSeq: null,
  type: "tool_call",
  payload: {
    tool: "history",
    query: "budget",
    callId: "c-budget",
    retrySafe: true,
    rerun: { tool: "history", input: { query: "budget" } },
  },
  scopeLabel: personal,
  createdAt: 2,
};

test("resumeInterruptedToolCall re-runs the recorded input exactly once and records only the result", async () => {
  const queries: string[] = [];
  const sink: Array<{ type: string; payload: unknown }> = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal, orgScopeId: turn.orgScopeId };

  const resumed = await resumeInterruptedToolCall(turn, ref, bridgedTools(ref, {}));

  assert.deepEqual(queries, ["budget"], "the tool body ran exactly once with the stripped input");
  assert.deepEqual(
    sink.map((e) => e.type),
    ["tool_result"],
    "the dangling tool_call entry is not re-recorded; only its result lands",
  );
  const result = sink[0]!.payload as { callId: string; result: string; isError: boolean };
  assert.equal(result.callId, "c-budget");
  assert.equal(result.isError, false);
  assert.match(result.result, /shared\/q2\.md/);
  assert.ok(resumed);
  assert.equal(resumed.history.length, 2, "the harness continues from history that now carries the result");
  assert.equal(resumed.history[1]!.type, "tool_result");
  assert.deepEqual(
    { ...resumed.message, timestamp: 0 },
    {
      role: "toolResult",
      toolCallId: "c-budget",
      toolName: "history",
      content: [{ type: "text", text: "- user#3: the budget doc is in shared/q2.md (budget)" }],
      isError: false,
      timestamp: 0,
    },
  );
  assert.equal(ref.emit, turn.emit, "the emit hook is restored after the re-run");
});

test("resumeInterruptedToolCall does nothing without a call to resume", async () => {
  const queries: string[] = [];
  const sink: Array<{ type: string; payload: unknown }> = [];
  const tools = historyToolContext(queries);
  const idle = turnFor([danglingCall], undefined, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: idle.emit, scopeLabel: personal };
  assert.equal(await resumeInterruptedToolCall(idle, ref, bridgedTools(ref, {})), null);
  assert.deepEqual(queries, []);
  assert.deepEqual(sink, []);
});

test("when the tool is unavailable on the retried turn the call is closed as interrupted instead of left dangling", async () => {
  const queries: string[] = [];
  const sink: Array<{ type: string; payload: unknown }> = [];
  const tools = historyToolContext(queries);
  const missing = turnFor([danglingCall], { callId: "c-x", tool: "no_such_tool", input: {} }, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: missing.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(missing, ref, bridgedTools(ref, {}));
  assert.ok(resumed);
  assert.equal(resumed.message.isError, true);
  assert.equal(resumed.message.content[0]!.text, INTERRUPTED_TOOL_RESULT);
  assert.deepEqual(
    sink.map((e) => [e.type, (e.payload as { callId: string; result: string }).result]),
    [["tool_result", INTERRUPTED_TOOL_RESULT]],
  );
  assert.equal((sink[0]!.payload as { interrupted?: boolean }).interrupted, true, "the ledger carries the meaning");
  assert.deepEqual(queries, []);
});

test("a cancelled turn does not re-run anything and closes the call as interrupted", async () => {
  const queries: string[] = [];
  const sink: Array<{ type: string; payload: unknown }> = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  turn.cancel = AbortSignal.abort();
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(turn, ref, bridgedTools(ref, {}));
  assert.equal(resumed?.message.isError, true);
  assert.deepEqual(queries, []);
  assert.equal(sink.length, 1);
  assert.equal(ref.abortSignal, undefined, "the cancel signal is only borrowed for the re-run");
});

test("a tool that throws during the re-run still records an error result so the model sees a closed call", async () => {
  const sink: Array<{ type: string; payload: unknown }> = [];
  const tools = {
    async history() {
      throw new Error("transcript index offline");
    },
  } as unknown as ToolContext;
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(turn, ref, bridgedTools(ref, {}));
  assert.ok(resumed);
  assert.equal(resumed.message.isError, true);
  assert.match(resumed.message.content[0]!.text ?? "", /transcript index offline/);
  assert.deepEqual(
    sink.map((e) => [e.type, (e.payload as { callId: string; isError: boolean }).isError]),
    [["tool_result", true]],
  );
});

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the resume tests must not provision a sandbox");
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
  const received: Array<{
    input: string;
    continueTurn?: boolean;
    resumeToolCall?: ResumableToolCall;
    historyTypes: string[];
  }> = [];
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
        received.push({
          input: turn.input,
          ...(turn.continueTurn ? { continueTurn: true } : {}),
          ...(turn.resumeToolCall ? { resumeToolCall: turn.resumeToolCall } : {}),
          historyTypes: turn.history.map((e) => e.type),
        });
        if (turn.resumeToolCall) {
          await turn.emit({
            type: "tool_result",
            payload: { tool: "history", callId: turn.resumeToolCall.callId, isError: false, result: "- found it" },
            scopeLabel: turn.scopeLabel,
          });
        }
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        const reply = "we kept the Q2 budget flat";
        await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
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
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "tool-call-resume-")));
  const orchestrator = createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, createMemoryConfigStore(ORG), acl),
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
      ...singleProcessDeps(),
      deployStore: createDeployStore(),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "tool-call-resume-deploy"),
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
  return { orchestrator, sessions, runs, received, input };
}

async function seedDeadAttempt(
  sessions: ReturnType<typeof buildScenario>["sessions"],
  callPayload: Record<string, unknown>,
): Promise<{ sessionId: string; userSeq: number }> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", personal);
  const { lease } = await sessions.acquireLease(session.id);
  try {
    const user = await sessions.append(lease!, { type: "user", payload: { text: ASK }, scopeLabel: personal });
    await sessions.append(lease!, { type: "tool_call", payload: callPayload, scopeLabel: personal });
    return { sessionId: session.id, userSeq: user.seq };
  } finally {
    await sessions.releaseLease(lease!);
  }
}

test("a retry whose dangling call was marked retry-safe re-runs it silently instead of warning about an unknown outcome", async () => {
  const { orchestrator, sessions, runs, received, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const { sessionId, userSeq } = await seedDeadAttempt(sessions, {
    tool: "history",
    query: "budget",
    callId: "c-budget",
    retrySafe: true,
    rerun: { tool: "history", input: { query: "budget" } },
  });
  await runs.noteTurnUserSeq(run.id, userSeq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.equal(received.length, 1);
  const turn = received[0]!;
  assert.deepEqual(turn.resumeToolCall, { callId: "c-budget", tool: "history", input: { query: "budget" } });
  assert.equal(turn.continueTurn, true, "the harness continues the recorded turn instead of re-sending the request");

  const entries = await sessions.getEntries(sessionId);
  const types = entries.map((e) => e.type);
  assert.deepEqual(types, ["user", "tool_call", "tool_result", "user", "assistant"]);
});

for (const [label, payload] of [
  ["unsafe", { tool: "history", query: "budget", callId: "c-budget", retrySafe: false }],
  ["unmarked", { tool: "history", query: "budget", callId: "c-budget" }],
] as const) {
  test(`a retry whose dangling call is ${label} records what happened as its result and does not re-run it`, async () => {
    const { orchestrator, sessions, runs, received, input } = buildScenario();
    const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
    const { sessionId, userSeq } = await seedDeadAttempt(sessions, payload);
    await runs.noteTurnUserSeq(run.id, userSeq);

    const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
    assert.equal(retry.status, "ok");
    assert.equal(received.length, 1);
    const turn = received[0]!;
    assert.equal(turn.resumeToolCall, undefined);
    assert.equal(turn.continueTurn, true, "the harness continues the recorded turn instead of re-sending the request");
    const entries = await sessions.getEntries(sessionId);
    assert.deepEqual(
      entries.map((e) => e.type),
      ["user", "tool_call", "tool_result", "user", "assistant"],
      "nothing is re-run; the call gets a recorded result",
    );
    const result = entries[2]!.payload as { callId?: string; isError?: boolean; result?: string };
    assert.equal(result.callId, "c-budget");
    assert.equal(result.isError, true);
    assert.match(result.result ?? "", /^\[system\] This call was interrupted; its outcome wasn't recorded\./);
    assert.ok(turn.historyTypes.includes("tool_result"), "the model sees the recorded result");
  });
}
