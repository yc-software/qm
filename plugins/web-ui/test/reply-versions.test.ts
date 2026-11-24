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

test("a superseded chain shows its newest reply, with earlier versions behind one toggle", async () => {
  const { h, replies, texts } = await rendered(transcript(1, 5));
  try {
    assert.deepEqual(replies(), ["Third report"]);
    assert.equal(document.querySelectorAll(".tool-expandable").length, 2);
    const versions = document.querySelector<HTMLDetailsElement>("details.reply-versions")!;
    const summary = versions.querySelector("summary")!;
    assert.match(summary.textContent!.trim(), /^Updated \S.* · 2 earlier versions$/);
    assert.deepEqual(texts(".reply-versions .thinking-body qm-markdown"), ["First report", "Second report"]);
    assert.equal(versions.open, false);
    summary.click();
    assert.equal(versions.open, true);
    summary.click();
    assert.equal(versions.open, false);
  } finally {
    await h.close();
  }
});

test("replies without a supersedes marker, or pointing at one that is not loaded, all stay in place", async () => {
  for (const items of [transcript(), transcript(undefined, 404)]) {
    const { h, replies } = await rendered(items);
    try {
      assert.deepEqual(replies(), ["First report", "Second report", "Third report"]);
      assert.equal(document.querySelector(".reply-versions"), null);
    } finally {
      await h.close();
    }
  }
});
