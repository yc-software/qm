import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the transcript renders rows through the settled-row cache", () => {
  assert.match(chat, /messages\.map\(\(m, i\) =>\s*settledChatMessage\(m, i - inheritedOffset,/);
});

test("live, approval-paused, and subagent rows bypass the cache (their render reads mutable state)", () => {
  assert.match(
    chat,
    /const cacheable =\s*!isStreaming &&\s*!\(message as \{ subagentMail\?: SubagentMailRef \}\)\.subagentMail &&\s*!work\?\.activity\.some\(\(activity\) =>\s*\["session", "sessions"\]\.includes\(\(activity\.payload as ToolPayload \| null\)\?\.tool \?\? ""\),?\s*\) &&\s*\(!work \|\| \(\(work\.status === "complete" \|\| work\.status === "failed"\) && !work\.pendingApprovals\?\.length\)\)/,
  );
  assert.match(chat, /if \(!cacheable\) return chatMessage\(message, index, isStreaming\);/);
});

test("the cache key covers every mutable render input of a settled row", () => {
  for (const field of [
    "hit.day === day",
    "hit.index === index",
    "hit.activity === work?.activity",
    "hit.status === work?.status",
    "hit.stale === work?.stale",
    "hit.deliveredFiles === msg.deliveredFiles",
    "hit.stopReason === msg.stopReason",
    "hit.errorMessage === msg.errorMessage",
    "hit.approvalDecision === msg.approvalDecision",
    "hit.sendFailure === msg.sendFailure",
    "hit.forkable === forkable",
    "hit.speakerLabel === speakerLabel",
    "hit.edited === edited",
    "hit.deleted === deleted",
  ]) {
    assert.ok(chat.includes(field), `cache key must compare: ${field}`);
  }
});

test("prompt expansion is managed by the viewport without invalidating cached templates", () => {
  assert.doesNotMatch(chat, /expandedPrompt|togglePromptExpanded/);
});

test("canonical steering rows never enter the standalone cache during resume startup", () => {
  const settled = chat.slice(chat.indexOf("function settledChatMessage"), chat.indexOf("function chatMessage"));
  const suppression = settled.indexOf("if ((message as { steered?: boolean }).steered) return nothing;");
  assert.ok(suppression >= 0);
  assert.ok(suppression < settled.indexOf("settledRowCache.get"));
});
