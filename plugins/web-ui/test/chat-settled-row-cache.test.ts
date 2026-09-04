import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the transcript renders rows through the settled-row cache", () => {
  assert.match(chat, /messages\.map\(\(m, i\) =>\s*settledChatMessage\(m, i - inheritedOffset,/);
});

test("live or approval-paused rows bypass the cache (their render reads mutable state)", () => {
  assert.match(
    chat,
    /const cacheable =\s*!isStreaming &&\s*\(!work \|\| \(\(work\.status === "complete" \|\| work\.status === "failed"\) && !work\.pendingApprovals\?\.length\)\)/,
  );
  assert.match(chat, /if \(!cacheable\) return chatMessage\(message, index, isStreaming\);/);
});

test("the cache key covers every mutable render input of a settled row", () => {
  for (const field of [
    "hit.index === index",
    "hit.activity === work?.activity",
    "hit.status === work?.status",
    "hit.stale === work?.stale",
    "hit.deliveredFiles === msg.deliveredFiles",
    "hit.stopReason === msg.stopReason",
    "hit.errorMessage === msg.errorMessage",
    "hit.approvalDecision === msg.approvalDecision",
    "hit.forkable === forkable",
  ]) {
    assert.ok(chat.includes(field), `cache key must compare: ${field}`);
  }
});
