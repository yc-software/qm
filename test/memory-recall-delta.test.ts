import { compactTranscript } from "../src/harness/context-compaction.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryRecallDelta } from "../src/memory/recall-delta.ts";
import type { SessionEntry } from "../src/types.ts";

const notebook = (facts: string) => `### personal:alice\n# Memory\n\n${facts}`;
const entry = (body: string, seq = 1, anchorSeq?: number): SessionEntry => ({
  sessionId: "s",
  seq,
  type: "user",
  parentSeq: null,
  createdAt: 1,
  scopeLabel: "personal:alice",
  payload: { text: "hello", memoryRecall: { body, ...(anchorSeq !== undefined ? { anchorSeq } : {}) } },
});

test("first automatic recall is complete; repeated unchanged recall is empty after reload", () => {
  const body = notebook("- ALPHA\n- BETA");
  assert.equal(memoryRecallDelta(body, []).text, "### personal:alice\n# Memory\n- ALPHA\n- BETA");
  const persisted = JSON.parse(JSON.stringify([entry(body)])) as SessionEntry[];
  assert.equal(memoryRecallDelta(body, persisted).text, "");
});

test("changed notes emit additions and withdrawals with scope provenance, omitting unchanged facts", () => {
  const delta = memoryRecallDelta(notebook("- ALPHA\n- GAMMA"), [entry(notebook("- ALPHA\n- BETA"))]);
  assert.doesNotMatch(delta.text, /ALPHA/);
  assert.match(delta.text, /New or updated memory facts:[\s\S]*personal:alice[\s\S]*GAMMA/);
  assert.match(delta.text, /personal:alice: 1 earlier fact was consolidated or removed/);
  assert.doesNotMatch(delta.text, /BETA/);
  assert.equal(delta.record.anchorSeq, 1);
});

test("identical text under distinct scopes or headings keeps its distinct meaning", () => {
  const prior = notebook("- SAME");
  const next = `${prior}\n\n### channel:eng\n# Memory\n- SAME`;
  const delta = memoryRecallDelta(next, [entry(prior)]);
  assert.match(delta.text, /channel:eng/);
  assert.doesNotMatch(delta.text, /personal:alice/);
});

test("multiline facts remain intact and headings with unchanged content add nothing", () => {
  const prior = notebook("## Profile\n- Works remotely\n  from London\n\n## Project\nOld paragraph.");
  const next = prior.replace("Old paragraph.", "Updated paragraph.");
  const delta = memoryRecallDelta(next, [entry(prior)]);
  assert.doesNotMatch(delta.text, /Works remotely|London|Profile/);
  assert.match(delta.text, /## Project\nUpdated paragraph/);
});

test("compacting away the recall anchor restores a current baseline", () => {
  const body = notebook("- ALPHA\n- BETA");
  const history = [entry(body, 8, 1)];
  assert.match(memoryRecallDelta(body, history).text, /ALPHA\n- BETA/);
  assert.equal(memoryRecallDelta(body, history).record.anchorSeq, undefined);
});

test("all removed facts are withdrawn and repeated empty memory adds nothing", () => {
  const before = notebook("- OLD");
  assert.equal(
    memoryRecallDelta("", [entry(before)], ["personal:alice"]).text,
    "personal:alice: 1 earlier fact was consolidated or removed; rely only on the current list.",
  );
  assert.equal(memoryRecallDelta("", [entry(before), entry("", 3, 1)]).text, "");
});

test("withdrawals never quote facts from a revoked or disabled memory scope", () => {
  const body = notebook("- PRIVATE_FACT");
  const result = memoryRecallDelta("", [entry(body)], []);
  assert.doesNotMatch(result.text, /PRIVATE_FACT|personal:alice/);
  assert.match(result.text, /no longer included/);
});

test("each scope and heading is rendered once and bookkeeping markers are never facts", () => {
  const body = `### personal:alice\n### personal:alice\n## Work\n- ONE\n\n- TWO\n<!-- consolidated: 2026-10-01 -->\n<!-- captures-since-promote: 4 -->`;
  assert.equal(memoryRecallDelta(body, []).text, "### personal:alice\n## Work\n- ONE\n- TWO");
  const delta = memoryRecallDelta(body.replace("- TWO", "- THREE\n- FOUR"), [entry(body)]);
  assert.equal(
    delta.text,
    "New or updated memory facts:\n\n### personal:alice\n## Work\n- THREE\n- FOUR\n\npersonal:alice: 1 earlier fact was consolidated or removed; rely only on the current list.",
  );
});

test("recall checkpoint metadata never leaks into attachment-only compaction input", () => {
  const recorded = entry(notebook("- CHECKPOINT_ONLY_FACT"));
  recorded.payload = { ...(recorded.payload as Record<string, unknown>), text: "", environment: "file: report.csv" };
  const text = compactTranscript([recorded]);
  assert.match(text, /report.csv/);
  assert.doesNotMatch(text, /CHECKPOINT_ONLY_FACT|memoryRecall/);
});
