import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { messageLinkSeq, loadMessageTranscript, messageEntrySeqs, highlightMessage } from "../src/message-link.ts";
import { sessionLink } from "../src/deep-link.ts";
import { entriesToMessages, type TranscriptPage } from "../src/core-bridge.ts";

test("message URLs preserve zero and reject malformed, negative, and unsafe sequences", () => {
  assert.equal(messageLinkSeq("?seq=120"), 120);
  assert.equal(messageLinkSeq("?seq=0"), 0);
  for (const q of ["", "?seq=", "?seq=-1", "?seq=1.5", "?seq=1e2", "?seq=9007199254740992", "?seq=abc"])
    assert.equal(messageLinkSeq(q), null);
  assert.equal(sessionLink("https://qm.example", "/web-ui", "s1", 120), "https://qm.example/web-ui/s/s1?seq=120");
});

test("an old message link loads older pages while retaining the live tail and remaining history", async () => {
  const calls: unknown[] = [];
  const page = (seqs: number[], earlierEntries: number): TranscriptPage => ({
    entries: seqs.map((seq) => ({ type: "user", seq, createdAt: seq, payload: { text: `Message ${seq}` } })),
    earlierEntries,
  });
  const pages = [page([200, 201], 200), page([100, 120, 200], 100)];
  const result = await loadMessageTranscript(
    async (window) => {
      calls.push(window);
      return pages.shift()!;
    },
    120,
    10,
  );
  assert.deepEqual(
    result.entries.map((e) => e.seq),
    [100, 120, 200, 201],
  );
  assert.equal(result.earlierEntries, 100);
  assert.deepEqual(calls, [{ tailTurns: 10 }, { tailTurns: 40, beforeSeq: 200 }]);
});

test("unavailable entries terminate without an endless pagination loop", async () => {
  let calls = 0;
  await loadMessageTranscript(
    async () => {
      calls++;
      return { entries: [{ type: "user", seq: 200, createdAt: 0, payload: { text: "x" } }], earlierEntries: 20 };
    },
    120,
    10,
  );
  assert.equal(calls, 2);
});

test("user, assistant, and collapsed final text entries retain their message target", () => {
  const messages = entriesToMessages([
    { type: "user", seq: 120, createdAt: 1, payload: { text: "hi" } },
    { type: "text", seq: 121, parentSeq: 120, createdAt: 2, payload: { text: "hello" } },
    { type: "assistant", seq: 122, parentSeq: 120, createdAt: 3, payload: { text: "hello" } },
  ]);
  assert.deepEqual(messageEntrySeqs(messages[0]), [120]);
  assert.deepEqual(messageEntrySeqs(messages[1]), [122, 121]);
});

test("a linked row is focused, centered and highlighted", () => {
  const dom = new JSDOM('<main><article class="message-row" data-entry-seqs="120 121"></article></main>');
  const host = dom.window.document.querySelector("main")!;
  const row = host.querySelector("article")!;
  let scrolled = false;
  row.scrollIntoView = () => {
    scrolled = true;
  };
  assert.equal(highlightMessage(host, 120), true);
  assert.equal(scrolled, true);
  assert.equal(row.classList.contains("linked-message"), true);
  assert.equal(dom.window.document.activeElement, row);
  assert.equal(highlightMessage(host, 999), false);
});
