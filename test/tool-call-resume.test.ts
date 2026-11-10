import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import type { ResumableToolCall } from "../src/core/turn-resume.ts";
import { INTERRUPTED_TOOL_RESULT } from "../src/agent/context-compaction.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Agent, AgentTurnInput } from "../src/agent/agent.ts";
import { resumeInterruptedToolCall, type BridgedTool } from "../src/agent/turn-support.ts";
import { toolCallApprovalKey } from "../src/core/approval-id.ts";
import { createAgentTools, type ToolContextRef } from "../src/agent/agent-tools.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "web:U1:resume", audience: [actor] };
const personal = scopeId("personal", "U1");
const ASK = "what did we decide about the budget?";

function historyToolContext(calls: string[]): ToolContext {
  return {
    async history(q: string) {
      calls.push(q);
      return [`UserMessage#3: the budget doc is in shared/q2.md (${q})`];
    },
  } as unknown as ToolContext;
}

function turnFor(
  history: Item[],
  call: ResumableToolCall | undefined,
  sink: Item[],
  tools: ToolContext,
): AgentTurnInput {
  let seq = history.length + 10;
  return {
    session: { id: "s1" } as AgentTurnInput["session"],
    input: "(system note: resumed)",
    systemPrompt: "BASE",
    history,
    tools,
    scopeLabel: personal,
    orgScopeId: scopeId("org", ORG),
    emit: async (item) => {
      const stored = storedItem(item, { sessionId: "s1", seq: seq++, createdAt: 1000 + seq });
      sink.push(stored);
      return stored;
    },
    recordModelCall: () => {},
    ...(call ? { resumeToolCall: call } : {}),
  };
}

const danglingCall = storedItem(
  {
    kind: "ToolCall",
    tool: "history",
    callId: "c-budget",
    body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
  },
  { sessionId: "s1", seq: 2, createdAt: 2 },
);

test("resumeInterruptedToolCall re-runs the recorded input exactly once and records only the result", async () => {
  const queries: string[] = [];
  const sink: Item[] = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  const emit: ToolContextRef["emit"] = (item) => turn.emit(item);
  const ref: ToolContextRef = { current: tools, emit, scopeLabel: personal, orgScopeId: turn.orgScopeId };

  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref) as unknown as BridgedTool[]);

  assert.deepEqual(queries, ["budget"], "the tool body ran exactly once with the stripped input");
  assert.deepEqual(
    sink.map((e) => e.kind),
    ["ToolResult"],
    "the dangling tool_call entry is not re-recorded; only its result lands",
  );
  const result = sink[0]!;
  assert.equal(result.callId, "c-budget");
  assert.equal(result.isError, false);
  assert.match(result.text ?? "", /shared\/q2\.md/);
  assert.ok(resumed);
  assert.equal(resumed.history.length, 2, "the agent continues from history that now carries the result");
  assert.equal(resumed.history[1]!.kind, "ToolResult");
  assert.deepEqual(
    { ...resumed.message, timestamp: 0 },
    {
      role: "toolResult",
      toolCallId: "c-budget",
      toolName: "history",
      content: [{ type: "text", text: "- UserMessage#3: the budget doc is in shared/q2.md (budget)" }],
      isError: false,
      timestamp: 0,
    },
  );
  assert.equal(ref.emit, emit, "the emit hook is restored after the re-run");
});

test("resumeInterruptedToolCall does nothing without a call to resume", async () => {
  const queries: string[] = [];
  const sink: Item[] = [];
  const tools = historyToolContext(queries);
  const idle = turnFor([danglingCall], undefined, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: (item) => idle.emit(item), scopeLabel: personal };
  assert.equal(await resumeInterruptedToolCall(idle, ref, createAgentTools(ref) as unknown as BridgedTool[]), null);
  assert.deepEqual(queries, []);
  assert.deepEqual(sink, []);
});

test("when the tool is unavailable on the retried turn the call is closed as interrupted instead of left dangling", async () => {
  const queries: string[] = [];
  const sink: Item[] = [];
  const tools = historyToolContext(queries);
  const missing = turnFor([danglingCall], { callId: "c-x", tool: "no_such_tool", input: {} }, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: (item) => missing.emit(item), scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(missing, ref, createAgentTools(ref) as unknown as BridgedTool[]);
  assert.ok(resumed);
  assert.equal(resumed.message.isError, true);
  assert.equal(resumed.message.content[0]!.text, INTERRUPTED_TOOL_RESULT);
  assert.deepEqual(
    sink.map((e) => [e.kind, e.text]),
    [["ToolResult", INTERRUPTED_TOOL_RESULT]],
  );
  assert.equal(sink[0]!.body.interrupted, true, "the ledger carries the meaning");
  assert.deepEqual(queries, []);
});

test("a cancelled turn does not re-run anything and closes the call as interrupted", async () => {
  const queries: string[] = [];
  const sink: Item[] = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  turn.cancel = AbortSignal.abort();
  const ref: ToolContextRef = { current: tools, emit: (item) => turn.emit(item), scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref) as unknown as BridgedTool[]);
  assert.equal(resumed?.message.isError, true);
  assert.deepEqual(queries, []);
  assert.equal(sink.length, 1);
  assert.equal(ref.abortSignal, undefined, "the cancel signal is only borrowed for the re-run");
});

test("a tool that throws during the re-run still records an error result so the model sees a closed call", async () => {
  const sink: Item[] = [];
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
  const ref: ToolContextRef = { current: tools, emit: (item) => turn.emit(item), scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref) as unknown as BridgedTool[]);
  assert.ok(resumed);
  assert.equal(resumed.message.isError, true);
  assert.match(resumed.message.content[0]!.text ?? "", /transcript index offline/);
  assert.deepEqual(
    sink.map((e) => [e.kind, e.isError]),
    [["ToolResult", true]],
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
    approvedToolCalls?: AgentTurnInput["approvedToolCalls"];
    toolApprovalGate?: AgentTurnInput["toolApprovalGate"];
    historyKinds: string[];
  }> = [];
  const agent: Agent = {
    async runTurn(turn) {
      received.push({
        input: turn.input,
        ...(turn.continueTurn ? { continueTurn: true } : {}),
        ...(turn.resumeToolCall ? { resumeToolCall: turn.resumeToolCall } : {}),
        ...(turn.approvedToolCalls ? { approvedToolCalls: turn.approvedToolCalls } : {}),
        ...(turn.toolApprovalGate ? { toolApprovalGate: turn.toolApprovalGate } : {}),
        historyKinds: turn.history.map((e) => e.kind),
      });
      if (turn.resumeToolCall) {
        await turn.emit({
          kind: "ToolResult",
          tool: "history",
          callId: turn.resumeToolCall.callId,
          isError: false,
          text: "- found it",
        });
      }
      await turn.emit({ kind: "UserMessage", text: turn.input });
      const reply = "we kept the Q2 budget flat";
      await turn.emit({ kind: "AgentMessage", text: reply });
      return { reply, modelCalls: 1 };
    },
    async screenSecurity() {
      return { decision: "auto" as const };
    },
  };
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const orchestrator = createOrchestrator({
    ...orchestratorTestDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, testConfigStore(ORG), acl),
    config: testConfigStore(ORG),
    sessions,
    runs,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    auditLog,
    agent,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
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
  call: NewItem<"ToolCall">,
): Promise<{ sessionId: string; userSeq: number }> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", personal);
  const writer = { sessionId: session.id };
  const user = await sessions.append(writer, { kind: "UserMessage", text: ASK });
  await sessions.append(writer, call);
  return { sessionId: session.id, userSeq: user.seq };
}

test("a retry whose dangling call was marked retry-safe re-runs it silently instead of warning about an unknown outcome", async () => {
  const { orchestrator, sessions, runs, received, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const { sessionId, userSeq } = await seedDeadAttempt(sessions, {
    kind: "ToolCall",
    tool: "history",
    callId: "c-budget",
    body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
  });
  await runs.noteTurnUserSeq(run.id, userSeq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.equal(received.length, 1);
  const turn = received[0]!;
  assert.deepEqual(turn.resumeToolCall, { callId: "c-budget", tool: "history", input: { query: "budget" } });
  assert.equal(turn.continueTurn, true, "the agent continues the recorded turn instead of re-sending the request");

  const items = await sessions.getItems(sessionId);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["UserMessage", "ToolCall", "ToolResult", "UserMessage", "AgentMessage"],
  );
});

for (const [label, payload] of [
  ["unsafe", { kind: "ToolCall", tool: "history", callId: "c-budget", body: { query: "budget", retrySafe: false } }],
  ["unmarked", { kind: "ToolCall", tool: "history", callId: "c-budget", body: { query: "budget" } }],
] satisfies Array<[string, NewItem<"ToolCall">]>) {
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
    assert.equal(turn.continueTurn, true, "the agent continues the recorded turn instead of re-sending the request");
    const items = await sessions.getItems(sessionId);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["UserMessage", "ToolCall", "ToolResult", "UserMessage", "AgentMessage"],
      "nothing is re-run; the call gets a recorded result",
    );
    const result = items[2]!;
    assert.equal(result.callId, "c-budget");
    assert.equal(result.isError, true);
    assert.match(result.text ?? "", /^\[system\] This call was interrupted; its outcome wasn't recorded\./);
    assert.ok(turn.historyKinds.includes("ToolResult"), "the model sees the recorded result");
  });
}

test("a retry with two dangling calls records both as interrupted and re-runs neither, even if one is retry-safe", async () => {
  const { orchestrator, sessions, runs, received, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const { sessionId, userSeq } = await seedDeadAttempt(sessions, {
    kind: "ToolCall",
    tool: "history",
    callId: "c-budget",
    body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
  });
  await sessions.append({ sessionId }, { kind: "ToolCall", tool: "execute", callId: "c-build", body: {} });
  await runs.noteTurnUserSeq(run.id, userSeq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.equal(received[0]!.resumeToolCall, undefined);
  const results = (await sessions.getItems(sessionId)).filter((item) => item.kind === "ToolResult");
  assert.deepEqual(
    results.map((item) => [item.callId, item.isError, item.body.interrupted]),
    [
      ["c-budget", true, true],
      ["c-build", true, true],
    ],
  );
});

for (const [label, resultTurn] of [
  ["in its own turn", undefined],
  ["under another turn", "00000000-0000-4000-8000-0000000000ff"],
] as const) {
  test(`a retry-safe call whose result is already recorded ${label} is not re-run or answered twice`, async () => {
    const { orchestrator, sessions, runs, received, input } = buildScenario();
    const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
    const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", personal);
    const writer = { sessionId: session.id, turnId: run.id };
    const user = await sessions.append(writer, { kind: "UserMessage", text: ASK });
    await sessions.append(writer, {
      kind: "ToolCall",
      tool: "history",
      callId: "c-budget",
      body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
    });
    await sessions.append(
      { sessionId: session.id, turnId: resultTurn ?? run.id },
      {
        kind: "ToolResult",
        tool: "history",
        callId: "c-budget",
        isError: true,
        text: "[exit 143]",
        body: { interrupted: true, stop: { kind: "shutdown" } },
      },
    );
    await runs.noteTurnUserSeq(run.id, user.seq);

    const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
    assert.equal(retry.status, "ok");
    assert.equal(received[0]!.resumeToolCall, undefined);
    const results = (await sessions.getItems(session.id)).filter((item) => item.kind === "ToolResult");
    assert.deepEqual(
      results.map((item) => item.text),
      ["[exit 143]"],
    );
  });
}

test("a retried turn runs an approved call its first attempt recorded but never started, through the gate, once", async () => {
  const { orchestrator, sessions, runs, received, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", personal);
  const writer = { sessionId: session.id, turnId: run.id };
  const call = { callId: "approved_req7_aa11", requestId: "req7", tool: "history", input: { query: "budget" } };
  const approvalKey = toolCallApprovalKey(call.tool, call.input);
  await sessions.append(writer, { kind: "UserMessage", text: ASK });
  await sessions.append(writer, {
    kind: "ElicitationResponse",
    elicitId: "req7",
    approved: true,
    author: "U1",
    body: { command: "history", scope: "once", call, approvalKey },
  });

  await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  const turn = received.at(-1)!;
  assert.deepEqual(turn.approvedToolCalls, [call], "the stored call is run on the retry");
  assert.equal(turn.toolApprovalGate?.(call.tool, approvalKey), true, "the retry carries the once-use approval");
  assert.equal(turn.toolApprovalGate?.(call.tool, approvalKey), false, "and only once");

  await sessions.append(
    { sessionId: session.id, turnId: randomUUID() },
    {
      kind: "ToolCall",
      tool: call.tool,
      callId: call.callId,
      body: { approvedRequestId: "req7" },
    },
  );
  await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 3 }));
  assert.equal(received.at(-1)!.approvedToolCalls, undefined, "a call that started in any run is never run again");
});
