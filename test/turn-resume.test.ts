import { test } from "node:test";
import assert from "node:assert/strict";
import { findTrailingPartialTurn, isResumeNote, resumeNote } from "../src/core/turn-resume.ts";
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
  const entries = [user("build and deploy the release", 1), user(resumeNote({ workRecorded: false }), 2)];
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
  assert.ok(!isResumeNote("build and deploy the release"));
});

test("the no-work wording promises nothing recorded, and neither wording re-sends the input", () => {
  const restart = resumeNote({ workRecorded: false });
  assert.ok(isResumeNote(restart));
  assert.doesNotMatch(restart, /recorded above|Continue from where you left off/);
  assert.match(restart, /nothing to pick up\. Start the request now/);
  for (const note of [resumeNote(), restart]) assert.doesNotMatch(note, /build and deploy the release/);
});

test("isResumeNote recognizes the pre-rename notes recorded in existing ledgers", () => {
  const legacy =
    "(system note: the platform restarted mid-turn and interrupted your previous attempt at the request above. Continue.)";
  assert.ok(isResumeNote(legacy));
  const entries = [user("build and deploy the release", 1), toolCall(2), user(legacy, 3)];
  assert.deepEqual(findTrailingPartialTurn(entries, "build and deploy the release"), { userSeq: 1, workEntries: 1 });
});
