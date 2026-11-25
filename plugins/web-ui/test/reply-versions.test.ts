import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

const at = Date.now() - 3_600_000;
const reply = (seq: number, text: string, supersedes?: number) =>
  item("AgentMessage", { seq, createdAt: at + seq * 1000, text, body: supersedes === undefined ? {} : { supersedes } });
const wake = (seq: number) => [
  item("UserMessage", { seq, createdAt: at + seq * 1000, text: "A delegated task finished.", hidden: true }),
  item("ToolCall", { seq: seq + 1, createdAt: at + seq * 1000, tool: "execute", callId: `c${seq}`, body: {} }),
  item("ToolResult", { seq: seq + 2, createdAt: at + seq * 1000, tool: "execute", callId: `c${seq}`, text: "ok" }),
];
const transcript = (first?: number, second?: number) => [
  item("UserMessage", { seq: 0, createdAt: at, text: "Compare the two vendors" }),
  reply(1, "First report"),
  ...wake(2),
  reply(5, "Second report", first),
  ...wake(6),
  reply(9, "Third report", second),
];

async function rendered(items: unknown[]) {
  const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], items });
  h.releaseSessions();
  await h.boot();
  await h.sessionsReady();
  const texts = (selector: string) =>
    [...document.querySelectorAll<Element & { content?: string }>(selector)].map((el) => el.content);
  return { h, replies: () => texts(".assistant-body > .streaming-text qm-markdown"), texts };
}

test("a superseded chain folds into one work row and its newest reply, with earlier versions behind the footer", async () => {
  const { h, replies, texts } = await rendered(transcript(1, 5));
  try {
    assert.deepEqual(replies(), ["Third report"]);
    assert.equal(document.querySelectorAll(".assistant-row").length, 1);
    assert.equal(document.querySelectorAll(".assistant-row details.work").length, 1);
    assert.equal(document.querySelectorAll(".tool-expandable").length, 2);
    const toggle = () => document.querySelector<HTMLButtonElement>(".message-meta .reply-versions-toggle")!;
    assert.equal(toggle().textContent!.trim(), "· edited");
    assert.equal(document.querySelector(".reply-versions-list"), null);
    for (const seq of [1, 5])
      assert.ok(document.querySelector(`.message-row[data-entry-seqs~="${seq}"]`)?.contains(toggle()));
    toggle().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(texts(".reply-versions-list .thinking-body qm-markdown"), ["First report", "Second report"]);
    toggle().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector(".reply-versions-list"), null);
  } finally {
    await h.close();
  }
});

test("replies without a supersedes marker, or pointing at one that is not loaded, all stay in place", async () => {
  for (const items of [transcript(), transcript(undefined, 404)]) {
    const { h, replies } = await rendered(items);
    try {
      assert.deepEqual(replies(), ["First report", "Second report", "Third report"]);
      assert.equal(document.querySelector(".reply-versions-toggle"), null);
    } finally {
      await h.close();
    }
  }
});

test("a reply or error outside the chain stays in place and stops the fold", async () => {
  const { h, replies } = await rendered([
    item("UserMessage", { seq: 0, createdAt: at, text: "Compare the two vendors" }),
    reply(1, "On it"),
    ...wake(2),
    reply(5, "First report"),
    item("Error", { seq: 6, createdAt: at + 6000, text: "Provider unavailable" }),
    ...wake(7),
    reply(10, "Second report", 5),
  ]);
  try {
    assert.deepEqual(replies(), ["On it", "Second report"]);
    assert.match(document.querySelector(".composer-error")?.textContent ?? "", /Provider unavailable/);
  } finally {
    await h.close();
  }
});

const said = (seq: number, text: string) => [
  item("AgentMessage", { seq, createdAt: at + seq * 1000, text, variant: "narration" }),
  item("ToolCall", { seq: seq + 1, createdAt: at + seq * 1000, tool: "execute", callId: `n${seq}`, body: {} }),
  item("ToolResult", { seq: seq + 2, createdAt: at + seq * 1000, tool: "execute", callId: `n${seq}`, text: "ok" }),
];
const answer = (seq: number, text: string, body: Record<string, unknown>) =>
  item("AgentMessage", { seq, createdAt: at + seq * 1000, text, body });
const standaloneSaid = () =>
  [...document.querySelectorAll<Element & { content?: string }>(".work-said qm-markdown")]
    .filter((el) => !el.closest("details"))
    .map((el) => el.content);

test("every message since the person last typed folds into the newest reply, narration inside the work row", async () => {
  const typedTurn = [
    item("UserMessage", { seq: 0, createdAt: at, text: "Ship the guidance change" }),
    ...said(1, "Running the triage"),
    ...said(4, "Rerunning on the real commit"),
  ];
  const plain = await rendered([...typedTurn, answer(7, "Typed answer", {})]);
  try {
    assert.deepEqual(standaloneSaid(), ["Running the triage", "Rerunning on the real commit"]);
  } finally {
    await plain.h.close();
  }
  const { h, replies, texts } = await rendered([
    ...typedTurn,
    answer(7, "Typed answer", { alsoSupersedes: [1, 4] }),
    ...wake(8),
    reply(11, "Stacked report"),
    ...wake(12),
    ...said(15, "All lenses accept"),
    answer(18, "Final answer", { supersedes: 11, alsoSupersedes: [7, 15] }),
  ]);
  try {
    assert.deepEqual(replies(), ["Final answer"]);
    assert.deepEqual(standaloneSaid(), []);
    assert.equal(document.querySelectorAll(".assistant-row").length, 1);
    document.querySelector<HTMLButtonElement>(".message-meta .reply-versions-toggle")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(texts(".reply-versions-list .thinking-body qm-markdown"), ["Typed answer", "Stacked report"]);
  } finally {
    await h.close();
  }
});
