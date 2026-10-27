import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTrailingPartialTurn,
  resumeStrategy,
  runtimeSwitchNote,
  turnAtSeq,
  type ResumableToolCall,
} from "../../src/core/turn-resume.ts";
import { unrecordedToolResult, INTERRUPTED_TOOL_RESULT } from "../../src/harness/context-compaction.ts";
import { storedItem, type NewItem, type Item } from "../../src/sessions/items.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createResolutionService } from "../../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createModelGateway } from "../../src/model/model-gateway.ts";
import { defineHarness, type HarnessTurnInput } from "../../src/harness/harness.ts";
import { resumeInterruptedToolCall, type BridgedTool } from "../../src/harness/harness-shared.ts";
import { createAgentTools, type ToolContextRef } from "../../src/harness/agent-tools.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import { scopeId, type Conversation, type Principal } from "../../src/types.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "../support/test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { testRunStore } from "../support/turns.ts";

const RUN_0 = "00000000-0000-4000-8000-000000000000";
const RUN_1 = "00000000-0000-4000-8000-000000000001";
const RUN_2 = "00000000-0000-4000-8000-000000000002";
const MY_TURN = "00000000-0000-4000-8000-0000000000aa";
const OTHER_TURN = "00000000-0000-4000-8000-0000000000bb";

function ent(item: NewItem, seq: number) {
  return storedItem(item, { sessionId: "s", seq, createdAt: seq });
}

const user = (text: string, seq: number, runId = RUN_1) => ent({ kind: "UserMessage", text, turnId: runId }, seq);
const overheard = (text: string, seq: number) =>
  ent({ kind: "UserMessage", text, externalId: String(seq), body: { overheard: true, name: "Alice" } }, seq);
const LEGACY_NOTE = "[system] Your previous attempt was interrupted mid-turn. Continue from the recorded work.";
const resumeEntry = (seq: number) =>
  ent({ kind: "UserMessage", text: LEGACY_NOTE, hidden: true, body: { resumeNote: true } }, seq);
const assistant = (text: string, seq: number) => ent({ kind: "AgentMessage", text }, seq);
const toolCall = (seq: number) =>
  ent({ kind: "ToolCall", tool: "execute", callId: `c${seq}`, body: { command: "make build" } }, seq);
const toolResult = (seq: number) => ent({ kind: "ToolResult", callId: `c${seq - 1}`, text: "ok" }, seq);
const steer = (text: string, seq: number) =>
  ent({ kind: "SteeringMessage", text, turnId: RUN_1, body: { ts: String(seq) } }, seq);
const delivered = (text: string, seq: number) => ent({ kind: "AgentMessage", text, turnId: OTHER_TURN }, seq);

test("findTrailingPartialTurn finds the dead attempt's user entry and counts its partial work", () => {
  const entries = [
    user("earlier ask", 1),
    assistant("earlier reply", 2),
    user("build and deploy the release\n\n<environment note>", 3),
    toolCall(4),
    toolResult(5),
    toolCall(6),
  ];
  const found = findTrailingPartialTurn(entries, RUN_1);
  assert.deepEqual(found, { userSeq: 3, workEntries: 3 });
});

test("findTrailingPartialTurn returns null when the last turn completed (assistant entry present)", () => {
  const entries = [user("do the thing", 1), toolCall(2), toolResult(3), assistant("done", 4)];
  assert.equal(findTrailingPartialTurn(entries, RUN_1), null);
});

test("findTrailingPartialTurn returns null when the trailing user entry belongs to another run", () => {
  const entries = [user("an older abandoned ask", 1, RUN_0), toolCall(2)];
  assert.equal(findTrailingPartialTurn(entries, RUN_1), null);
});

test("a trailing steer is not the run's turn", () => {
  assert.equal(findTrailingPartialTurn([user("do the thing", 1), toolCall(2), steer("also this", 3)], RUN_1), null);
});

test("an attempt that died before recording ANY work reports workEntries 0", () => {
  const found = findTrailingPartialTurn([user("build and deploy the release", 1)], RUN_1);
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("platform rails and render-only rows are NOT work — only tool rows replay to the resumed model", () => {
  const entries = [
    user("build and deploy the release", 1),
    ent({ kind: "Wake", wakeCause: "system", body: { text: "expired upload" } }, 2),
    ent({ kind: "Reasoning", text: "let me plan", body: { thinkingSignature: "SIG" } }, 3),
    ent({ kind: "AgentMessage", variant: "narration", text: "on it" }, 4),
  ];
  const found = findTrailingPartialTurn(entries, RUN_1);
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("a prior no-work retry's restart note is skipped — later retries anchor on the human's entry", () => {
  const entries = [
    user("build and deploy the release", 1),
    ent({ kind: "UserMessage", text: LEGACY_NOTE, body: { resumeNote: true } }, 2),
  ];
  const found = findTrailingPartialTurn(entries, RUN_1);
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 }, "provenance stays on the original, not attempt 2's prompt");
});

test("overheard catch-up rows trailing the dead attempt are skipped, reaching the real user entry", () => {
  const entries = [
    user("build and deploy the release\n\n<environment note>", 1),
    toolCall(2),
    overheard("build and deploy the release please someone", 3),
    overheard("unrelated chatter", 4),
  ];
  const found = findTrailingPartialTurn(entries, RUN_1);
  assert.deepEqual(
    found,
    { userSeq: 1, workEntries: 1 },
    "resolves to the trigger; overheard rows are not the dead attempt's work",
  );
});

test("a session whose only trailing user rows are overheard is NOT a resume", () => {
  const entries = [assistant("earlier reply", 1), overheard("build and deploy the release", 2)];
  assert.equal(findTrailingPartialTurn(entries, RUN_1), null);
});

test("an empty-reply completed turn still counts as completed (assistant entry with empty text)", () => {
  const entries = [user("do the thing", 1), assistant("", 2)];
  assert.equal(findTrailingPartialTurn(entries, RUN_1), null);
});

test("a resume note in the ledger is skipped by its flag, not its text", () => {
  const entries = [user("build and deploy the release", 1), toolCall(2), resumeEntry(3)];
  assert.deepEqual(findTrailingPartialTurn(entries, RUN_1), { userSeq: 1, workEntries: 1 });
  const typed = [user("build and deploy the release", 1), toolCall(2), user(LEGACY_NOTE, 3, RUN_2)];
  assert.equal(findTrailingPartialTurn(typed, RUN_1), null, "typed text is a new request");
});

test("turnAtSeq carries the answer the attempt recorded, so a retry can replay it", () => {
  const entries = [user("do the thing", 1), toolCall(2), toolResult(3), assistant("done", 4)];
  assert.deepEqual(turnAtSeq(entries, 1), { userSeq: 1, workEntries: 2, answer: { seq: 4, text: "done" } });
});

test("turnAtSeq reports an unanswered turn with its recorded work so the retry resumes", () => {
  const entries = [user("do the thing", 1), toolCall(2), toolResult(3)];
  assert.deepEqual(turnAtSeq(entries, 1), { userSeq: 1, workEntries: 2 });
});

test("turnAtSeq ignores an assistant entry that precedes the turn's own user entry", () => {
  const entries = [user("earlier ask", 1), assistant("earlier reply", 2), user("do the thing", 3), toolCall(4)];
  assert.deepEqual(turnAtSeq(entries, 3), { userSeq: 3, workEntries: 1 });
});

test("turnAtSeq stops at a later ask, so another run's answer is not read as this turn's", () => {
  const entries = [user("mine", 1), user("someone else's", 2), assistant("answering the other one", 3)];
  assert.deepEqual(turnAtSeq(entries, 1), { userSeq: 1, workEntries: 0 });
});

test("turnAtSeq reads through the resume note and the overheard traffic of its own turn", () => {
  const entries = [
    user("mine", 1),
    toolCall(2),
    overheard("chatter", 3),
    resumeEntry(4),
    toolCall(5),
    assistant("finished", 6),
  ];
  assert.deepEqual(turnAtSeq(entries, 1), { userSeq: 1, workEntries: 2, answer: { seq: 6, text: "finished" } });
});

test("turnAtSeq returns null when the recorded seq is outside the entries it was given", () => {
  assert.equal(turnAtSeq([user("do the thing", 3)], 1), null);
  assert.equal(turnAtSeq([], 1), null);
});

test("turnAtSeq distinguishes a repeated identical ask that findTrailingPartialTurn cannot", () => {
  const entries = [user("go", 1), assistant("went", 2), user("go", 3), toolCall(4)];
  assert.deepEqual(turnAtSeq(entries, 3), { userSeq: 3, workEntries: 1 });
  assert.deepEqual(turnAtSeq(entries, 1), { userSeq: 1, workEntries: 0, answer: { seq: 2, text: "went" } });
});

test("turnAtSeq reads through a mid-turn steer, which is the person adding to this same turn", () => {
  const entries = [
    user("deploy", 10),
    toolCall(11),
    steer("also tag it", 12),
    toolResult(13),
    assistant("deployed", 14),
  ];
  assert.deepEqual(turnAtSeq(entries, 10), {
    userSeq: 10,
    workEntries: 3,
    answer: { seq: 14, text: "deployed" },
  });
});

test("turnAtSeq ignores another conversation's delivery", () => {
  const entries = [
    ent({ kind: "UserMessage", text: "mine", turnId: MY_TURN }, 10),
    toolCall(11),
    delivered("Nightly report", 12),
  ];
  assert.deepEqual(turnAtSeq(entries, 10), { userSeq: 10, workEntries: 1 });
});

test("turnAtSeq reports the turn's last answer, matching what the turn itself would return", () => {
  const entries = [user("mine", 10), assistant("first pass", 11), toolCall(12), assistant("after the nudge", 13)];
  assert.deepEqual(turnAtSeq(entries, 10), {
    userSeq: 10,
    workEntries: 1,
    answer: { seq: 13, text: "after the nudge" },
  });
});

const safeCall = (seq: number, retrySafe: boolean) =>
  ent(
    {
      kind: "ToolCall",
      tool: "history",
      callId: `c${seq}`,
      body: {
        query: "deploy",
        retrySafe,
        ...(retrySafe ? { rerun: { tool: "history", input: { query: "deploy", limit: 5 } } } : {}),
      },
    },
    seq,
  );

test("resumeStrategy re-runs a lone dangling call the model marked retry-safe, with its stripped input", () => {
  const entries = [user("build and deploy the release", 1), toolCall(2), toolResult(3), safeCall(4, true)];
  assert.deepEqual(resumeStrategy(entries, { userSeq: 1, workEntries: 3 }), {
    kind: "retry",
    call: { callId: "c4", tool: "history", input: { query: "deploy", limit: 5 } },
  });
});

test("resumeStrategy records what happened to calls it cannot safely re-run: unsafe, unmarked, or ambiguous", () => {
  const unsafe = [user("build and deploy the release", 1), safeCall(2, false)];
  assert.deepEqual(resumeStrategy(unsafe, { userSeq: 1, workEntries: 1 }), {
    kind: "settle",
    calls: [{ callId: "c2", tool: "history" }],
  });
  const unmarked = [user("build and deploy the release", 1), toolCall(2)];
  assert.deepEqual(resumeStrategy(unmarked, { userSeq: 1, workEntries: 1 }), {
    kind: "settle",
    calls: [{ callId: "c2", tool: "execute" }],
  });
  const twoDangling = [user("build and deploy the release", 1), safeCall(2, true), safeCall(3, true)];
  assert.deepEqual(resumeStrategy(twoDangling, { userSeq: 1, workEntries: 2 }), {
    kind: "settle",
    calls: [
      { callId: "c2", tool: "history" },
      { callId: "c3", tool: "history" },
    ],
  });
  const priorTurnCall = [safeCall(0, true), user("build and deploy the release", 1), toolCall(2), toolResult(3)];
  assert.deepEqual(resumeStrategy(priorTurnCall, { userSeq: 1, workEntries: 2 }), { kind: "continue" });
});

test("resumeStrategy restarts when the dead attempt recorded no work", () => {
  assert.deepEqual(resumeStrategy([user("x", 1)], { userSeq: 1, workEntries: 0 }), { kind: "restart" });
});

test("a tool call whose outcome was lost records the cause as its own result", () => {
  assert.match(
    unrecordedToolResult({ kind: "shutdown" }),
    /^\[system\] A routine platform deploy interrupted this call/,
  );
  assert.match(
    unrecordedToolResult({ kind: "error", code: "transient", status: 503 }),
    /^\[system\] A model-provider failure \(transient, HTTP 503\) interrupted this call/,
  );
  assert.match(unrecordedToolResult({ kind: "lease_expired" }), /^\[system\] A worker crash interrupted this call/);
  assert.match(unrecordedToolResult(undefined), /^\[system\] This call was interrupted; its outcome wasn't recorded/);
});

test("the runtime switch note names the new runtime", () => {
  assert.match(
    runtimeSwitchNote({ modelId: "claude-opus-5-5", fastMode: true, effortLevel: "high" }),
    /^\[system\] Runtime switched to claude-opus-5-5 fast; effort high\./,
  );
  assert.doesNotMatch(runtimeSwitchNote({ modelId: "claude-opus-5-5" }), /fast|effort/);
  assert.match(runtimeSwitchNote(undefined), /^\[system\] Context was trimmed without a new summary\./);
});

test("a tool result marked interrupted does not answer its call, so the call is still resumable", () => {
  const killed = ent({ kind: "ToolResult", callId: "c4", text: "[exit 143]", body: { interrupted: true } }, 5);
  const entries = [user("build and deploy the release", 1), safeCall(4, true), killed];
  assert.equal(resumeStrategy(entries, { userSeq: 1, workEntries: 2 }).kind, "retry");
  const unsafe = [user("build and deploy the release", 1), safeCall(4, false), killed];
  assert.deepEqual(
    resumeStrategy(unsafe, { userSeq: 1, workEntries: 2 }),
    { kind: "continue" },
    "it already has a result",
  );
});

test("resumeStrategy continues silently whenever every call is answered", () => {
  const thinking = (seq: number) => ent({ kind: "Reasoning", text: "hm" }, seq);
  const killed = (seq: number) =>
    ent({ kind: "ToolResult", callId: `c${seq - 1}`, text: "[exit 143]", body: { interrupted: true } }, seq);
  const partial = { userSeq: 1, workEntries: 2 };
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3)], partial), { kind: "continue" });
  assert.deepEqual(resumeStrategy([user("go", 1), safeCall(2, true), toolResult(3)], partial), { kind: "continue" });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3), thinking(4)], partial), {
    kind: "continue",
  });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3), steer("also", 4)], partial), {
    kind: "continue",
  });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3), resumeEntry(4)], partial), {
    kind: "continue",
  });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), killed(3)], partial), { kind: "continue" });
  assert.deepEqual(resumeStrategy([safeCall(0, true), user("go", 1), toolCall(2)], { userSeq: 1, workEntries: 1 }), {
    kind: "settle",
    calls: [{ callId: "c2", tool: "execute" }],
  });
  assert.deepEqual(
    resumeStrategy([user("go", 1), toolCall(2), toolResult(3), safeCall(4, true), killed(5)], {
      userSeq: 1,
      workEntries: 4,
    }).kind,
    "retry",
  );
});

test("an unrelated message does not close an interrupted turn or supply its answer", () => {
  const entries = [
    ent({ kind: "UserMessage", text: "mine", turnId: MY_TURN }, 10),
    toolCall(11),
    delivered("Nightly report", 12),
  ];
  assert.deepEqual(findTrailingPartialTurn(entries, MY_TURN), { userSeq: 10, workEntries: 1 });
  assert.deepEqual(turnAtSeq(entries, 10), { userSeq: 10, workEntries: 1 });
});

test("a steered mid-turn message does not hide the turn's answer", () => {
  const at = (item: NewItem, seq: number) => storedItem(item, { sessionId: "s", seq, createdAt: seq });
  const flagged = [
    at({ kind: "UserMessage", text: "deploy" }, 1),
    at({ kind: "SteeringMessage", text: "also tag it" }, 2),
    at({ kind: "AgentMessage", text: "done" }, 3),
  ];
  const unflagged = [
    at({ kind: "UserMessage", text: "deploy" }, 1),
    at({ kind: "UserMessage", text: "also tag it" }, 2),
    at({ kind: "AgentMessage", text: "done" }, 3),
  ];
  assert.deepEqual(turnAtSeq(flagged, 1)?.answer, { seq: 3, text: "done" });
  assert.equal(turnAtSeq(unflagged, 1)?.answer, undefined, "without the flag the answered turn reads as unanswered");
});

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
  sink: NewItem[],
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
    emit: async (item) => {
      sink.push(item);
      const at = seq++;
      return storedItem(item, { sessionId: "s1", seq: at, createdAt: 1000 + at });
    },
    recordModelCall: () => {},
    ...(call ? { resumeToolCall: call } : {}),
  };
}

const danglingCall: Item = storedItem(
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
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal, orgScopeId: turn.orgScopeId };

  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);

  assert.deepEqual(queries, ["budget"], "the tool body ran exactly once with the stripped input");
  assert.deepEqual(
    sink.map((e) => e.kind),
    ["ToolResult"],
    "the dangling ToolCall item is not re-recorded; only its result lands",
  );
  const result = sink[0]!;
  assert.equal(result.callId, "c-budget");
  assert.equal(result.isError, false);
  assert.match(result.text ?? "", /shared\/q2\.md/);
  assert.ok(resumed);
  assert.equal(resumed.length, 2, "the harness continues from history that now carries the result");
  assert.equal(resumed[1]!.kind, "ToolResult");
  assert.equal(resumed[1]!.callId, "c-budget");
  assert.equal(resumed[1]!.isError, false);
  assert.match(resumed[1]!.text ?? "", /shared\/q2\.md/);
  assert.equal(ref.emit, turn.emit, "the emit hook is restored after the re-run");
});

test("resumeInterruptedToolCall does nothing without a call to resume", async () => {
  const queries: string[] = [];
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const idle = turnFor([danglingCall], undefined, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: idle.emit, scopeLabel: personal };
  assert.equal(await resumeInterruptedToolCall(idle, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]), null);
  assert.deepEqual(queries, []);
  assert.deepEqual(sink, []);
});

test("when the tool is unavailable on the retried turn the call is closed as interrupted instead of left dangling", async () => {
  const queries: string[] = [];
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const missing = turnFor([danglingCall], { callId: "c-x", tool: "no_such_tool", input: {} }, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: missing.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(missing, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);
  assert.ok(resumed);
  assert.equal(resumed.at(-1)!.isError, true);
  assert.equal(resumed.at(-1)!.text, INTERRUPTED_TOOL_RESULT);
  assert.deepEqual(
    sink.map((e) => [e.kind, e.text]),
    [["ToolResult", INTERRUPTED_TOOL_RESULT]],
  );
  assert.equal(sink[0]!.body?.interrupted, true, "the ledger carries the meaning");
  assert.deepEqual(queries, []);
});

test("a cancelled turn does not re-run anything and closes the call as interrupted", async () => {
  const queries: string[] = [];
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  turn.cancel = AbortSignal.abort();
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);
  assert.equal(resumed?.at(-1)?.isError, true);
  assert.deepEqual(queries, []);
  assert.equal(sink.length, 1);
  assert.equal(ref.abortSignal, undefined, "the cancel signal is only borrowed for the re-run");
});

test("a tool that throws during the re-run still records an error result so the model sees a closed call", async () => {
  const sink: NewItem[] = [];
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
  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);
  assert.ok(resumed);
  assert.equal(resumed.at(-1)!.isError, true);
  assert.match(resumed.at(-1)!.text ?? "", /transcript index offline/);
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
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: false },
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
  const harness = defineHarness({
    async runTurn(turn) {
      received.push({
        input: turn.input,
        ...(turn.resumeToolCall ? { resumeToolCall: turn.resumeToolCall } : {}),
        historyTypes: turn.history.map((e) => e.kind),
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
  });
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = testRunStore();
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "tool-call-resume-")));
  const orchestrator = createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(testDatabaseUrl()),
    resolution: createResolutionService(testConfigStore(), acl),
    sessions,
    runs,
    workspace,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 100, windowMs: 60_000 }),
    harness,
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
    outbound: recordingOutbound(),
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
  call: NewItem,
): Promise<{ sessionId: string; userSeq: number }> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", personal);
  const { lease } = await sessions.acquireLease(session.id);
  try {
    const user = await sessions.append(lease!, { kind: "UserMessage", text: ASK });
    await sessions.append(lease!, call);
    return { sessionId: session.id, userSeq: user.seq };
  } finally {
    await sessions.releaseLease(lease!);
  }
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
  assert.equal(turn.input, "", "the request is not re-sent");

  const items = await sessions.getItems(sessionId);
  const kinds = items.map((e) => e.kind);
  assert.deepEqual(kinds, ["UserMessage", "ToolCall", "ToolResult", "UserMessage", "AgentMessage"]);
});

for (const [label, payload] of [
  ["unsafe", { kind: "ToolCall", tool: "history", callId: "c-budget", body: { query: "budget", retrySafe: false } }],
  ["unmarked", { kind: "ToolCall", tool: "history", callId: "c-budget", body: { query: "budget" } }],
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
    assert.equal(turn.input, "", "the request is not re-sent");
    const items = await sessions.getItems(sessionId);
    assert.deepEqual(
      items.map((e) => e.kind),
      ["UserMessage", "ToolCall", "ToolResult", "UserMessage", "AgentMessage"],
      "nothing is re-run; the call gets a recorded result",
    );
    const result = items[2]!;
    assert.equal(result.callId, "c-budget");
    assert.equal(result.isError, true);
    assert.match(result.text ?? "", /^\[system\] This call was interrupted; its outcome wasn't recorded\./);
    assert.ok(turn.historyTypes.includes("ToolResult"), "the model sees the recorded result");
  });
}
