import { test } from "node:test";
import assert from "node:assert/strict";
import { isResumeNote, resumeNote, turnAtSeq } from "../src/core/turn-resume.ts";
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

test("turnAtSeq distinguishes a repeated identical ask by its own seq", () => {
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
