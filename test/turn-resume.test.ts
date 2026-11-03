import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTrailingPartialTurn,
  overtaken,
  reconcile,
  runtimeSwitchNote,
  turnAtSeq,
} from "../src/core/turn-resume.ts";
import { unrecordedToolResult } from "../src/agent/context-compaction.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

const RUN_0 = "00000000-0000-4000-8000-000000000000";
const RUN_1 = "00000000-0000-4000-8000-000000000001";
const RUN_2 = "00000000-0000-4000-8000-000000000002";
const OTHER_TURN = "00000000-0000-4000-8000-0000000000ff";

const item = (fields: NewItem, seq: number): Item => storedItem(fields, { sessionId: "s", seq, createdAt: seq });

const user = (text: string, seq: number, runId = RUN_1) => item({ kind: "UserMessage", text, turnId: runId }, seq);
const overheard = (text: string, seq: number) =>
  item({ kind: "UserMessage", text, externalId: String(seq), body: { overheard: true, name: "Alice" } }, seq);
const LEGACY_NOTE = "[system] Your previous attempt was interrupted mid-turn. Continue from the recorded work.";
const resumeEntry = (seq: number) =>
  item({ kind: "UserMessage", text: LEGACY_NOTE, hidden: true, body: { resumeNote: true } }, seq);
const assistant = (text: string, seq: number) => item({ kind: "AgentMessage", text }, seq);
const toolCall = (seq: number) =>
  item({ kind: "ToolCall", tool: "execute", callId: `c${seq}`, body: { command: "make build" } }, seq);
const toolResult = (seq: number) => item({ kind: "ToolResult", callId: `c${seq - 1}`, text: "ok" }, seq);
const killedResult = (callId: string, seq: number) =>
  item({ kind: "ToolResult", callId, text: "[exit 143]", body: { interrupted: true } }, seq);
const steer = (text: string, seq: number) =>
  item({ kind: "SteeringMessage", text, turnId: RUN_1, body: { ts: String(seq) } }, seq);
const delivered = (text: string, seq: number) => item({ kind: "AgentMessage", text, turnId: OTHER_TURN }, seq);

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

test("a trailing resume note from a prior dead resume is skipped, reaching the real user entry", () => {
  const entries = [user("build and deploy the release", 1), toolCall(2), resumeEntry(3), toolCall(4)];
  const found = findTrailingPartialTurn(entries, RUN_1);
  assert.deepEqual(found, { userSeq: 1, workEntries: 2 }, "the note itself is not work");
});

test("an attempt that died before recording ANY work reports workEntries 0", () => {
  const found = findTrailingPartialTurn([user("build and deploy the release", 1)], RUN_1);
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("prior resume notes alone are NOT work — repeated no-work deaths still report 0", () => {
  const entries = [user("build and deploy the release", 1), resumeEntry(2)];
  const found = findTrailingPartialTurn(entries, RUN_1);
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("platform rails and render-only rows are NOT work — only tool rows replay to the resumed model", () => {
  const entries = [
    user("build and deploy the release", 1),
    item({ kind: "Wake", wakeCause: "system", body: { text: "expired upload" } }, 2),
    item({ kind: "Reasoning", text: "let me plan", body: { thinkingSignature: "SIG" } }, 3),
    item({ kind: "AgentMessage", text: "on it", variant: "narration" }, 4),
  ];
  const found = findTrailingPartialTurn(entries, RUN_1);
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("a prior no-work retry's restart note is skipped — later retries anchor on the human's entry", () => {
  const entries = [
    user("build and deploy the release", 1),
    item({ kind: "UserMessage", text: LEGACY_NOTE, body: { resumeNote: true } }, 2),
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
  const typed = [
    user("build and deploy the release", 1),
    toolCall(2),
    item({ kind: "UserMessage", text: LEGACY_NOTE }, 3),
  ];
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
  const entries = [user("mine", 10), toolCall(11), delivered("Nightly report", 12)];
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
  item(
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

test("an unrelated message does not close an interrupted turn or supply its answer", () => {
  const entries = [user("mine", 10), toolCall(11), delivered("Nightly report", 12)];
  assert.deepEqual(findTrailingPartialTurn(entries, RUN_1), { userSeq: 10, workEntries: 1 });
  assert.deepEqual(turnAtSeq(entries, 10), { userSeq: 10, workEntries: 1 });
});

const settled = (calls: Array<[string, string]>, stop?: Parameters<typeof unrecordedToolResult>[0]) =>
  calls.map(([callId, tool]) => ({
    kind: "ToolResult",
    tool,
    callId,
    isError: true,
    text: unrecordedToolResult(stop),
    body: { interrupted: true },
  }));

test("reconcile writes nothing when every call in the turn has a result", () => {
  const thinking = (seq: number) => item({ kind: "Reasoning", text: "hm" }, seq);
  const turn = { userSeq: 1, workEntries: 2 };
  const done = { settleItems: [], resumed: true };
  assert.deepEqual(reconcile([user("go", 1), toolCall(2), toolResult(3)], turn), done);
  assert.deepEqual(reconcile([user("go", 1), safeCall(2, true), toolResult(3)], turn), done);
  assert.deepEqual(reconcile([user("go", 1), toolCall(2), toolResult(3), thinking(4)], turn), done);
  assert.deepEqual(reconcile([user("go", 1), toolCall(2), toolResult(3), steer("also", 4)], turn), done);
  assert.deepEqual(reconcile([user("go", 1), toolCall(2), toolResult(3), resumeEntry(4)], turn), done);
  assert.deepEqual(reconcile([safeCall(0, true), user("go", 1), toolCall(2), toolResult(3)], turn), done);
});

test("reconcile closes a dangling call it cannot safely re-run with its interruption cause", () => {
  const stop = { kind: "shutdown" } as const;
  assert.deepEqual(reconcile([user("go", 1), safeCall(2, false)], { userSeq: 1, workEntries: 1 }, stop), {
    settleItems: settled([["c2", "history"]], stop),
    resumed: true,
  });
  assert.deepEqual(reconcile([user("go", 1), toolCall(2)], { userSeq: 1, workEntries: 1 }), {
    settleItems: settled([["c2", "execute"]]),
    resumed: true,
  });
  assert.deepEqual(reconcile([safeCall(0, true), user("go", 1), toolCall(2)], { userSeq: 1, workEntries: 1 }), {
    settleItems: settled([["c2", "execute"]]),
    resumed: true,
  });
});

test("reconcile re-runs a lone dangling retry-safe call with its stripped input and settles nothing", () => {
  const entries = [user("build and deploy the release", 1), toolCall(2), toolResult(3), safeCall(4, true)];
  assert.deepEqual(reconcile(entries, { userSeq: 1, workEntries: 3 }), {
    settleItems: [],
    resumed: true,
    rerun: { callId: "c4", tool: "history", input: { query: "deploy", limit: 5 } },
  });
  const killed = killedResult("c2", 3);
  const later = [user("build and deploy the release", 1), safeCall(2, true), killed, safeCall(4, true)];
  assert.equal(reconcile(later, { userSeq: 1, workEntries: 3 }).rerun?.callId, "c4");
});

test("reconcile re-runs nothing when more than one call is dangling, even if one is retry-safe", () => {
  const entries = [user("go", 1), safeCall(2, true), toolCall(3)];
  assert.deepEqual(reconcile(entries, { userSeq: 1, workEntries: 2 }), {
    settleItems: settled([
      ["c2", "history"],
      ["c3", "execute"],
    ]),
    resumed: true,
  });
  const bothSafe = [user("go", 1), safeCall(2, true), safeCall(3, true)];
  assert.equal(reconcile(bothSafe, { userSeq: 1, workEntries: 2 }).rerun, undefined);
});

test("reconcile resumes only when the interrupted attempt recorded work", () => {
  assert.deepEqual(reconcile([user("x", 1)], { userSeq: 1, workEntries: 0 }), { settleItems: [], resumed: false });
  assert.equal(reconcile([user("x", 1), toolCall(2), toolResult(3)], { userSeq: 1, workEntries: 2 }).resumed, true);
});

test("reconcile never answers a call that already holds a result, wherever that result sits", () => {
  const killed = killedResult("c4", 5);
  for (const retrySafe of [true, false])
    assert.deepEqual(reconcile([user("go", 1), safeCall(4, retrySafe), killed], { userSeq: 1, workEntries: 2 }), {
      settleItems: [],
      resumed: true,
    });
  const elsewhere = item({ kind: "ToolResult", callId: "c4", text: "ok", turnId: OTHER_TURN }, 5);
  const call = item(
    {
      kind: "ToolCall",
      tool: "history",
      callId: "c4",
      turnId: RUN_1,
      body: { retrySafe: true, rerun: { tool: "history", input: { query: "deploy" } } },
    },
    4,
  );
  assert.deepEqual(reconcile([user("go", 1), call, elsewhere], { userSeq: 1, workEntries: 2 }), {
    settleItems: [],
    resumed: true,
  });
});

test("reconcile leaves another turn's calls alone and re-runs only calls marked retry-safe", () => {
  const foreign = item({ kind: "ToolCall", tool: "execute", callId: "c2", turnId: OTHER_TURN, body: {} }, 2);
  assert.deepEqual(reconcile([user("go", 1), foreign], { userSeq: 1, workEntries: 1 }), {
    settleItems: [],
    resumed: true,
  });
  const marked = (retrySafe: boolean) =>
    item(
      {
        kind: "ToolCall",
        tool: "history",
        callId: "c2",
        body: { retrySafe, rerun: { tool: "history", input: { query: "deploy" } } },
      },
      2,
    );
  assert.deepEqual(reconcile([user("go", 1), marked(false)], { userSeq: 1, workEntries: 1 }), {
    settleItems: settled([["c2", "history"]]),
    resumed: true,
  });
});

const exchange = (seq: number) => [
  user("quick question", seq, RUN_2),
  item({ kind: "AgentMessage", text: "PONG", turnId: RUN_2 }, seq + 1),
];

test("a paused turn is found past another run's exchange, and knows it was overtaken", () => {
  const entries = [user("nightly report", 10), toolCall(11), toolResult(12), ...exchange(13)];
  const partial = { userSeq: 10, workEntries: 2 };
  assert.deepEqual(findTrailingPartialTurn(entries, RUN_1), partial);
  assert.equal(overtaken(entries, partial, RUN_1), true);
  assert.equal(overtaken(entries.slice(0, 3), partial, RUN_1), false);
  assert.equal(overtaken([...entries.slice(0, 3), overheard("chatter", 13)], partial, RUN_1), false);
});

test("turnAtSeq reads past another run's exchange that overtook the turn, to the turn's own answer", () => {
  const entries = [
    user("nightly report", 10),
    toolCall(11),
    ...exchange(12),
    item({ kind: "UserMessage", text: "[system] paused", hidden: true, turnId: RUN_1, body: { resumeNote: true } }, 14),
    item({ kind: "AgentMessage", text: "report done", turnId: RUN_1 }, 15),
  ];
  assert.deepEqual(turnAtSeq(entries, 10), { userSeq: 10, workEntries: 1, answer: { seq: 15, text: "report done" } });
});

test("a paused turn that answered after another run's exchange is finished", () => {
  const entries = [
    user("nightly report", 10),
    toolCall(11),
    ...exchange(12),
    item({ kind: "UserMessage", text: "[system] paused", hidden: true, turnId: RUN_1, body: { resumeNote: true } }, 14),
    item({ kind: "AgentMessage", text: "report done", turnId: RUN_1 }, 15),
  ];
  assert.equal(findTrailingPartialTurn(entries, RUN_1), null);
});
