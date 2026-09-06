import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entriesToMessages, type AssistantWork, type SessionEntry, type WorkBlock } from "../src/core-bridge.ts";
import { workSeconds, workedLabel } from "../src/work-duration.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof entriesToMessages
>[1];

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

  assert.match(chat, /`Working for \$\{secs\}s` : workedLabel\("Worked", secs\)/);
  assert.match(chat, /function segmentSummaryLabel[\s\S]{0,400}?workSeconds\(work\)/);
});
