import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { isResumeNote, type ResumableToolCall } from "../src/core/turn-resume.ts";
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
  const received: Array<{ input: string; resumeToolCall?: ResumableToolCall; historyTypes: string[] }> = [];
  const harness = defineHarness(
    {
      id: "pi",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "pi",
      capabilities: new Set(["native-tape"]),
    },
    {
      async runTurn(turn) {
        received.push({
          input: turn.input,
          ...(turn.resumeToolCall ? { resumeToolCall: turn.resumeToolCall } : {}),
          historyTypes: turn.history.map((e) => e.type),
        });
        if (turn.resumeToolCall) {
          await turn.emit({
            type: "tool_result",
            payload: { tool: "history", callId: turn.resumeToolCall.callId, isError: false, result: "- found it" },
            scopeLabel: turn.scopeLabel,
          });
          await turn.tape?.({
            kind: "message",
            harness: "pi",
            payload: {
              role: "toolResult",
              toolCallId: turn.resumeToolCall.callId,
              toolName: "history",
              content: [{ type: "text", text: "- found it" }],
              isError: false,
              timestamp: Date.now(),
            },
            scopeLabel: turn.scopeLabel,
          });
        }
        const userEntry = await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        await turn.tape?.({
          kind: "message",
          harness: "pi",
          payload: { role: "user", content: [{ type: "text", text: turn.input }], timestamp: Date.now() },
          scopeLabel: turn.scopeLabel,
          entrySeq: userEntry.seq,
          meta: { bareText: turn.input },
        });
        const reply = "we kept the Q2 budget flat";
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
          payload: { turnEnd: true },
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
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "tool-call-resume-")));
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
  siblingWithResult?: Record<string, unknown>,
  harness = "pi",
): Promise<{ sessionId: string; userSeq: number }> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", personal);
  const { lease } = await sessions.acquireLease(session.id);
  try {
    const user = await sessions.append(lease!, { type: "user", payload: { text: ASK }, scopeLabel: personal });
    await sessions.appendTape(lease!, {
      kind: "message",
      harness,
      payload: { role: "user", content: [{ type: "text", text: ASK }], timestamp: user.createdAt },
      scopeLabel: personal,
      entrySeq: user.seq,
      meta: { bareText: ASK },
    });
    if (siblingWithResult)
      await sessions.append(lease!, { type: "tool_call", payload: siblingWithResult, scopeLabel: personal });
    await sessions.append(lease!, { type: "tool_call", payload: callPayload, scopeLabel: personal });
    await sessions.appendTape(lease!, {
      kind: "message",
      harness,
      payload: {
        role: "assistant",
        content: [
          ...(siblingWithResult
            ? [{ type: "toolCall", id: "c-sibling", name: "history", arguments: { query: "q2" } }]
            : []),
          { type: "toolCall", id: "c-budget", name: "history", arguments: { query: "budget", retrySafe: true } },
        ],
        timestamp: Date.now(),
        stopReason: "stop",
      },
      scopeLabel: personal,
    });
    if (siblingWithResult)
      await sessions.append(lease!, {
        type: "tool_result",
        payload: { tool: "history", callId: "c-sibling", isError: false, result: "- q2 notes" },
        scopeLabel: personal,
      });
    return { sessionId: session.id, userSeq: user.seq };
  } finally {
    await sessions.releaseLease(lease!);
  }
}

const tapeEvents = async (sessions: ReturnType<typeof buildScenario>["sessions"], sessionId: string) =>
  (await sessions.getTape(sessionId))
    .filter((row) => row.kind === "context_event")
    .map((row) => (row.payload as { event: string }).event);

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
  assert.ok(isResumeNote(turn.input));
  assert.match(turn.input, /result of the tool call that was in flight is recorded above/);
  assert.doesNotMatch(turn.input, /unknown outcome/);
  assert.deepEqual(await tapeEvents(sessions, sessionId), [], "no interrupt or coverage import is baked into the tape");

  const entries = await sessions.getEntries(sessionId);
  const types = entries.map((e) => e.type);
  assert.deepEqual(types, ["user", "tool_call", "tool_result", "user", "assistant"]);
  const roles = (await sessions.getTape(sessionId))
    .filter((row) => row.kind === "message")
    .map((row) => (row.payload as { role: string }).role);
  assert.deepEqual(
    roles,
    ["user", "assistant", "toolResult", "user", "assistant"],
    "the tape closes the call before the note",
  );
});

for (const [label, payload] of [
  ["unsafe", { tool: "history", query: "budget", callId: "c-budget", retrySafe: false }],
  ["unmarked", { tool: "history", query: "budget", callId: "c-budget" }],
] as const) {
  test(`a retry whose dangling call is ${label} gets the routine-deploy interrupted note and no re-run`, async () => {
    const { orchestrator, sessions, runs, received, input } = buildScenario();
    const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
    const { sessionId, userSeq } = await seedDeadAttempt(sessions, payload);
    await runs.noteTurnUserSeq(run.id, userSeq);

    const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
    assert.equal(retry.status, "ok");
    assert.equal(received.length, 1);
    const turn = received[0]!;
    assert.equal(turn.resumeToolCall, undefined);
    assert.ok(isResumeNote(turn.input));
    assert.match(turn.input, /routine platform deploy/);
    assert.match(turn.input, /almost never warrants mentioning|almost never worth mentioning/);
    assert.match(turn.input, /unknown outcome/);
    assert.match(turn.input, /check what actually happened before redoing anything with side effects/);
    const types = (await sessions.getEntries(sessionId)).map((e) => e.type);
    assert.deepEqual(types, ["user", "tool_call", "user", "assistant"], "the call stays open; nothing is re-run");
  });
}

test("a parallel batch whose sibling result never reached the tape falls back to the note so the tape heals as one", async () => {
  const { orchestrator, sessions, runs, received, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const { sessionId, userSeq } = await seedDeadAttempt(
    sessions,
    {
      tool: "history",
      query: "budget",
      callId: "c-budget",
      retrySafe: true,
      rerun: { tool: "history", input: { query: "budget" } },
    },
    { tool: "history", query: "q2", callId: "c-sibling" },
  );
  await runs.noteTurnUserSeq(run.id, userSeq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.equal(
    received[0]!.resumeToolCall,
    undefined,
    "the entries alone look retry-safe, but the tape still has two open calls",
  );
  assert.match(received[0]!.input, /unknown outcome/);
  const roles = (await sessions.getTape(sessionId))
    .filter((row) => row.kind === "message")
    .map((row) => (row.payload as { role: string }).role);
  assert.ok(!roles.includes("toolResult"), "no lone toolResult row is appended next to a still-open sibling");
});

test("a session taped by another harness still re-runs from entries, since its tape is never served", async () => {
  const { orchestrator, sessions, runs, received, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const { userSeq } = await seedDeadAttempt(
    sessions,
    {
      tool: "history",
      query: "budget",
      callId: "c-budget",
      retrySafe: true,
      rerun: { tool: "history", input: { query: "budget" } },
    },
    undefined,
    "claude",
  );
  await runs.noteTurnUserSeq(run.id, userSeq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(received[0]!.resumeToolCall, { callId: "c-budget", tool: "history", input: { query: "budget" } });
  assert.doesNotMatch(received[0]!.input, /unknown outcome/);
});
