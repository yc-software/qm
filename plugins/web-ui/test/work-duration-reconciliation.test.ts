import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entriesToMessages, type AssistantWork, type SessionEntry, type WorkBlock } from "../src/core-bridge.ts";
import { workSeconds, workedLabel } from "../src/work-duration.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof entriesToMessages
>[1];

test("waiting for an approval decision does not count as active work", () => {
  const activity: WorkBlock["activity"] = [
    { seq: 1, parentSeq: null, type: "tool_call", payload: { command: "help" }, createdAt: 101_000 },
    { seq: 2, parentSeq: 1, type: "tool_result", payload: { blocked: "needs_approval" }, createdAt: 108_000 },
  ];
  assert.equal(workSeconds({ status: "working", startedAt: 100_000, activity }), 8);
  assert.equal(workSeconds({ status: "complete", startedAt: 100_000, finishedAt: 700_000, activity }), 8);
  const history = entriesToMessages([
    ...activity,
    { seq: 3, type: "approval_resolved", payload: { command: "help", approved: false }, createdAt: 700_000 },
  ]);
  assert.equal(workSeconds((history[0] as AssistantWork).work!), 7);
  const resumed = [
    ...activity,
    { seq: 4, parentSeq: null, type: "text" as const, payload: { text: "continuing" }, createdAt: 710_000 },
  ];
  assert.equal(workSeconds({ status: "complete", startedAt: 700_000, finishedAt: 715_000, activity: resumed }), 15);
});

for (const type of ["approval_request", "tool_result", "tool_call"] as const) {
  test(`${type} timing preserves initial thinking without counting the approval wait`, () => {
    const activity: WorkBlock["activity"] = [
      { seq: 1, parentSeq: null, type: "tool_call", payload: { command: "help" }, createdAt: 112_000 },
      {
        seq: 2,
        parentSeq: 1,
        type,
        payload: { blocked: "needs_approval", workStartedAt: 100_000, workFinishedAt: 113_000 },
        createdAt: 113_000,
      },
    ];
    const live = workSeconds({ status: "complete", startedAt: 100_000, activity });
    for (const decided of [false, true]) {
      const entries: SessionEntry[] = [...activity];
      if (decided)
        entries.push({
          seq: 3,
          type: "approval_resolved",
          payload: { command: "help", approved: false },
          createdAt: 700_000,
        });
      const work = (entriesToMessages(entries)[0] as AssistantWork).work!;
      assert.equal(workSeconds(work), live);
      assert.equal(workSeconds(work), 13);
    }
  });
}

test("work duration survives a transcript refresh — persisted turn timing wins over activity inference", () => {
  const runStartedAt = 100_000;
  const runFinishedAt = 113_000;

  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 99_000, seq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 112_000, seq: 2, parentSeq: 1 },
    {
      type: "tool_result",
      payload: { tool: "execute", code: 0, stdout: "a" },
      createdAt: 112_000,
      seq: 3,
      parentSeq: 2,
    },
    {
      type: "assistant",
      payload: { text: "done", workStartedAt: runStartedAt, workFinishedAt: runFinishedAt },
      createdAt: 112_100,
      seq: 4,
    },
  ];

  const liveWork: WorkBlock = {
    status: "complete",
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    activity: [],
  };
  const liveLabel = workedLabel("Worked", workSeconds(liveWork));
  assert.equal(liveLabel, "Worked for 13s");

  const msgs = entriesToMessages(entries, MODEL);
  const rebuilt = (msgs[1] as AssistantWork).work;
  assert.ok(rebuilt, "the assistant reply carries a work block after refresh");
  assert.equal(rebuilt.startedAt, runStartedAt, "persisted turn start round-trips");
  assert.equal(rebuilt.finishedAt, runFinishedAt, "persisted turn finish round-trips");
  const refreshedLabel = workedLabel("Worked", workSeconds(rebuilt));
  assert.equal(refreshedLabel, liveLabel, "the duration label is unchanged after refresh");
});

test("fold expansion does not change the duration — the label derives only from the work block, deterministically", () => {
  const work: WorkBlock = {
    status: "complete",
    startedAt: 100_000,
    finishedAt: 113_000,
    activity: [
      { seq: 2, parentSeq: 1, type: "tool_call", payload: { tool: "execute" }, createdAt: 112_000 },
      { seq: 3, parentSeq: 2, type: "tool_result", payload: { tool: "execute" }, createdAt: 112_000 },
    ],
  };

  const before = workedLabel("Worked", workSeconds(work));
  const after = workedLabel("Worked", workSeconds(work));
  assert.equal(before, "Worked for 13s");
  assert.equal(after, before, "re-rendering (fold toggle) yields the identical label");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3_600_000;
    assert.equal(workedLabel("Worked", workSeconds(work)), before);
  } finally {
    Date.now = realNow;
  }
});

test("historical transcripts without persisted timing keep the activity-inference fallback", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 100, seq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 120, seq: 3, parentSeq: 2 },
    { type: "assistant", payload: { text: "done" }, createdAt: 130, seq: 4 },
  ];
  const work = (entriesToMessages(entries, MODEL)[1] as AssistantWork).work;
  assert.equal(work?.startedAt, 110);
  assert.equal(work?.finishedAt, 130);
});

test("live and historical rendering consume the same duration helper (source-level guard)", () => {
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  assert.match(
    chat,
    /import \{ workSeconds, workedLabel \} from "\.\/work-duration"/,
    "chat renders via the shared helper",
  );

  assert.match(chat, /workedLabel\(work.status === "working" \? "Working" : "Worked", secs\)/);
  assert.match(chat, /function workLabel[\s\S]{0,400}?workSeconds\(work\)/);
});

test("live and completed work use compact minute and second labels", () => {
  for (const prefix of ["Working", "Worked"]) {
    for (const [seconds, duration] of [
      [7, "7s"],
      [60, "1m"],
      [65, "1m 5s"],
      [365, "6m 5s"],
    ] as const)
      assert.equal(workedLabel(prefix, seconds), `${prefix} for ${duration}`);
  }
});

test("work duration ends at final-answer start while the run stays active and survives history projection", () => {
  const phase = {
    seq: 3,
    parentSeq: null,
    type: "text_start" as const,
    payload: { phase: "final_answer", streamOffset: 11 },
    createdAt: 108_000,
  };
  const work: WorkBlock = { status: "working", startedAt: 100_000, activity: [phase] };
  assert.equal(workSeconds(work), 8);
  assert.equal(work.status, "working");
  const entries: SessionEntry[] = [
    { seq: 1, type: "user", payload: { text: "check" }, createdAt: 100_000 },
    { seq: 2, type: "text", payload: { text: "Checking.", phase: "commentary" }, createdAt: 102_000 },
    phase,
    {
      seq: 4,
      type: "assistant",
      payload: { text: "All clear.", workStartedAt: 100_000, workFinishedAt: 115_000 },
      createdAt: 115_000,
    },
  ];
  const messages = entriesToMessages(entries, MODEL);
  const answer = messages.find((message) => message.role === "assistant") as AssistantWork;
  assert.ok(answer.work);
  assert.equal(workSeconds(answer.work), 8);
  assert.equal(answer.work.status, "complete");
  assert.equal(answer.work.activity.find((entry) => entry.type === "text_start")?.seq, 3);
});
