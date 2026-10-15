import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTrailingPartialTurn,
  isResumeNote,
  resumeNote,
  resumeStrategy,
  runtimeSwitchNote,
  turnAtSeq,
  unrecordedToolResult,
} from "../src/core/turn-resume.ts";
import type { SessionEntry } from "../src/types.ts";

function ent(type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry {
  return { sessionId: "s", seq, parentSeq: null, type, payload, scopeLabel: "org:default-org", createdAt: seq };
}

const user = (text: string, seq: number) => ent("user", { text }, seq);
const overheard = (text: string, seq: number) =>
  ent("user", { overheard: true, ts: String(seq), name: "Alice", text }, seq);
const assistant = (text: string, seq: number) => ent("assistant", { text }, seq);
const toolCall = (seq: number) => ent("tool_call", { tool: "execute", callId: `c${seq}`, command: "make build" }, seq);
const toolResult = (seq: number) => ent("tool_result", { callId: `c${seq - 1}`, result: "ok" }, seq);
const steer = (text: string, seq: number) => ent("user", { text, ts: String(seq), steered: true }, seq);
const delivered = (text: string, seq: number) => ent("assistant", { text, deliveryKey: `run:other-${seq}` }, seq);

test("findTrailingPartialTurn finds the dead attempt's user entry and counts its partial work", () => {
  const entries = [
    user("earlier ask", 1),
    assistant("earlier reply", 2),
    user("build and deploy the release\n\n<environment note>", 3),
    toolCall(4),
    toolResult(5),
    toolCall(6),
  ];
  const found = findTrailingPartialTurn(entries, "build and deploy the release");
  assert.deepEqual(found, { userSeq: 3, workEntries: 3 });
});

test("findTrailingPartialTurn returns null when the last turn completed (assistant entry present)", () => {
  const entries = [user("do the thing", 1), toolCall(2), toolResult(3), assistant("done", 4)];
  assert.equal(findTrailingPartialTurn(entries, "do the thing"), null);
});

test("findTrailingPartialTurn returns null when the trailing user entry is a different request", () => {
  const entries = [user("an older abandoned ask", 1), toolCall(2)];
  assert.equal(findTrailingPartialTurn(entries, "build and deploy the release"), null);
});

test("findTrailingPartialTurn returns null for empty input text and empty ledgers", () => {
  assert.equal(findTrailingPartialTurn([user("x", 1)], "   "), null);
  assert.equal(findTrailingPartialTurn([], "do the thing"), null);
});

test("a trailing resume note from a prior dead resume is skipped, reaching the real user entry", () => {
  const entries = [user("build and deploy the release", 1), toolCall(2), user(resumeNote(), 3), toolCall(4)];
  const found = findTrailingPartialTurn(entries, "build and deploy the release");
  assert.deepEqual(found, { userSeq: 1, workEntries: 2 }, "the note itself is not work");
});

test("an attempt that died before recording ANY work reports workEntries 0", () => {
  const found = findTrailingPartialTurn([user("build and deploy the release", 1)], "build and deploy the release");
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("prior resume notes alone are NOT work — repeated no-work deaths still report 0", () => {
  const entries = [user("build and deploy the release", 1), user(resumeNote(), 2)];
  const found = findTrailingPartialTurn(entries, "build and deploy the release");
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("platform rails and render-only rows are NOT work — only tool rows replay to the resumed model", () => {
  const entries = [
    user("build and deploy the release", 1),
    ent("system", { kind: "file_event", problem: "expired upload" }, 2),
    ent("thinking", { thinking: "let me plan", thinkingSignature: "SIG" }, 3),
    ent("text", { text: "on it" }, 4),
    ent("delivery", { text: "ack" }, 5),
  ];
  const found = findTrailingPartialTurn(entries, "build and deploy the release");
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 });
});

test("a prior no-work retry's restart note is skipped — later retries anchor on the human's entry", () => {
  const entries = [user("build and deploy the release", 1), user(resumeNote({ strategy: { kind: "restart" } }), 2)];
  const found = findTrailingPartialTurn(entries, "build and deploy the release");
  assert.deepEqual(found, { userSeq: 1, workEntries: 0 }, "provenance stays on the original, not attempt 2's prompt");
});

test("overheard catch-up rows trailing the dead attempt are skipped, reaching the real user entry", () => {
  const entries = [
    user("build and deploy the release\n\n<environment note>", 1),
    toolCall(2),
    overheard("build and deploy the release please someone", 3),
    overheard("unrelated chatter", 4),
  ];
  const found = findTrailingPartialTurn(entries, "build and deploy the release");
  assert.deepEqual(
    found,
    { userSeq: 1, workEntries: 1 },
    "resolves to the trigger; overheard rows are not the dead attempt's work",
  );
});

test("a session whose only trailing user rows are overheard is NOT a resume", () => {
  const entries = [assistant("earlier reply", 1), overheard("build and deploy the release", 2)];
  assert.equal(findTrailingPartialTurn(entries, "build and deploy the release"), null);
});

test("an empty-reply completed turn still counts as completed (assistant entry with empty text)", () => {
  const entries = [user("do the thing", 1), assistant("", 2)];
  assert.equal(findTrailingPartialTurn(entries, "do the thing"), null);
});

test("resumeNote is recognized by isResumeNote and mentions background jobs only when offered", () => {
  assert.ok(isResumeNote(resumeNote()));
  assert.ok(isResumeNote(resumeNote({ backgroundJobs: true })));
  assert.doesNotMatch(resumeNote(), /background/i);
  assert.match(resumeNote({ backgroundJobs: true }), /`background` list\/poll/);
  assert.ok(isResumeNote(runtimeSwitchNote(undefined)));
  assert.ok(isResumeNote(runtimeSwitchNote({ harnessId: "pi", modelId: "claude-opus-5-5" })));
  assert.ok(!isResumeNote("build and deploy the release"));
});

test("the no-work wording promises nothing recorded, and neither wording re-sends the input", () => {
  const restart = resumeNote({ strategy: { kind: "restart" } });
  assert.ok(isResumeNote(restart));
  assert.doesNotMatch(restart, /recorded work|Continue/);
  assert.match(restart, /Start the request now/);
  for (const note of [resumeNote(), restart]) assert.doesNotMatch(note, /build and deploy the release/);
});

test("isResumeNote recognizes the pre-rename notes recorded in existing ledgers", () => {
  const legacy =
    "(system note: the platform restarted mid-turn and interrupted your previous attempt at the request above. Continue.)";
  assert.ok(isResumeNote(legacy));
  const entries = [user("build and deploy the release", 1), toolCall(2), user(legacy, 3)];
  assert.deepEqual(findTrailingPartialTurn(entries, "build and deploy the release"), { userSeq: 1, workEntries: 1 });
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
    user(resumeNote(), 4),
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

test("turnAtSeq ignores an assistant entry that is another conversation's delivery", () => {
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
  ent(
    "tool_call",
    {
      tool: "history",
      query: "deploy",
      callId: `c${seq}`,
      retrySafe,
      ...(retrySafe ? { rerun: { tool: "history", input: { query: "deploy", limit: 5 } } } : {}),
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

test("the resume notes state the recorded cause and are recognized as resume notes", () => {
  const note = resumeNote();
  assert.ok(isResumeNote(note));
  assert.match(note, /cause not recorded/);
  assert.match(note, /Don't mention this/);
  assert.ok(
    isResumeNote(resumeNote({ strategy: { kind: "retry", call: { callId: "c1", tool: "history", input: {} } } })),
  );
});

test("a tool call whose outcome was lost records the cause as its own result", () => {
  assert.match(
    unrecordedToolResult({ kind: "shutdown" }),
    /^\[system\] A routine platform deploy interrupted this call/,
  );
  assert.match(unrecordedToolResult({ kind: "shutdown" }), /Don't mention this/);
  assert.match(
    unrecordedToolResult({ kind: "error", code: "transient", status: 503 }),
    /^\[system\] A model-provider failure \(transient, HTTP 503\) interrupted this call/,
  );
  assert.match(unrecordedToolResult({ kind: "lease_expired" }), /^\[system\] A worker crash interrupted this call/);
  assert.match(unrecordedToolResult(undefined), /^\[system\] This call was interrupted; its outcome wasn't recorded/);
});

test("the runtime switch note names the new runtime", () => {
  assert.match(
    runtimeSwitchNote({ harnessId: "pi", modelId: "claude-opus-5-5", fastMode: true, effortLevel: "high" }),
    /^\[system\] Runtime switched to claude-opus-5-5 fast; effort high\./,
  );
  assert.doesNotMatch(runtimeSwitchNote({ harnessId: "pi", modelId: "claude-opus-5-5" }), /fast|effort/);
  assert.match(runtimeSwitchNote(undefined), /^\[system\] Context was trimmed without a new summary\./);
});

test("a tool_result marked interrupted does not answer its call, so the call is still resumable", () => {
  const killed = ent("tool_result", { callId: "c4", result: "[exit 143]", interrupted: true }, 5);
  const entries = [user("build and deploy the release", 1), safeCall(4, true), killed];
  assert.equal(resumeStrategy(entries, { userSeq: 1, workEntries: 2 }).kind, "retry");
  const unsafe = [user("build and deploy the release", 1), safeCall(4, false), killed];
  assert.deepEqual(resumeStrategy(unsafe, { userSeq: 1, workEntries: 2 }), { kind: "note" }, "it already has a result");
});

test("resumeStrategy continues silently only when every call is answered and the ledger ends at a real tool result", () => {
  const thinking = (seq: number) => ent("thinking", { text: "hm" }, seq);
  const killed = (seq: number) =>
    ent("tool_result", { callId: `c${seq - 1}`, result: "[exit 143]", interrupted: true }, seq);
  const partial = { userSeq: 1, workEntries: 2 };
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3)], partial), { kind: "continue" });
  assert.deepEqual(resumeStrategy([user("go", 1), safeCall(2, true), toolResult(3)], partial), { kind: "continue" });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3), thinking(4)], partial), {
    kind: "continue",
  });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3), steer("also", 4)], partial), {
    kind: "note",
  });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), toolResult(3), user(resumeNote(), 4)], partial), {
    kind: "note",
  });
  assert.deepEqual(resumeStrategy([user("go", 1), toolCall(2), killed(3)], partial), { kind: "note" });
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

test("resume notes name exactly the cause the run store recorded", () => {
  assert.match(resumeNote({ cause: { kind: "shutdown" } }), /mid-turn — a routine platform deploy\./);
  assert.match(
    resumeNote({ cause: { kind: "error", code: "transient", status: 503 } }),
    /a model-provider call failed \(transient, HTTP 503\)/,
  );
  assert.match(
    resumeNote({ strategy: { kind: "restart" }, cause: { kind: "lease_expired" } }),
    /stopped before recording any work — the worker crashed\. Start the request now/,
  );
  assert.match(resumeNote({ cause: { kind: "error" } }), /— an internal error\./);
});
