import { compactTranscript } from "../src/harness/context-compaction.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryRecallDelta, shownFacts } from "../src/memory/recall-delta.ts";
import { renderFacts, type MemoryFact } from "../src/memory/facts.ts";
import type { SessionEntry } from "../src/types.ts";

const alice = "personal:alice";
const memoryFact = (id: string, text: string): MemoryFact => ({
  id,
  text,
  sensitivity: "ordinary",
  sources: [],
  sourceUnknown: false,
  createdAt: Date.parse("2026-10-01T12:00:00Z"),
  updatedAt: 0,
});
const fact = (id: string, text: string) => ({ scope: alice, id, text: renderFacts([memoryFact(id, text)]) });
const held = (...facts: Array<[string, string]>) =>
  new Map([[alice, shownFacts(facts.map(([id, text]) => memoryFact(id, text)))]]);
const entry = (record: unknown, seq = 1): SessionEntry => ({
  sessionId: "s",
  seq,
  type: "user",
  parentSeq: null,
  createdAt: 1,
  scopeLabel: alice,
  payload: { text: "hello", memoryRecall: JSON.parse(JSON.stringify(record)) },
});
const all = held(["1", "ALPHA"], ["2", "BETA"], ["3", "GAMMA"]);

test("the first recall is complete and an unchanged recall adds nothing", () => {
  const recalled = [fact("1", "ALPHA"), fact("2", "BETA")];
  const first = memoryRecallDelta(recalled, [], all, new Map([[alice, "Alice"]]));
  assert.equal(first.text, "### Alice\n- (2026-10-01) ALPHA\n- (2026-10-01) BETA");
  assert.equal(memoryRecallDelta(recalled, [entry(first.record)], all).text, "");
});

test("later recalls add only new facts, stay silent on held ones and withdraw deleted ones", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA"), fact("2", "BETA")], [], all);
  const second = memoryRecallDelta([fact("3", "GAMMA")], [entry(first.record)], all);
  assert.equal(second.text, "New or updated memory facts:\n\n### personal:alice\n- (2026-10-01) GAMMA");
  const history = [entry(first.record), entry(second.record, 2)];
  assert.equal(memoryRecallDelta([fact("1", "ALPHA")], history, all).text, "");
  assert.equal(
    memoryRecallDelta([fact("3", "GAMMA")], history, held(["3", "GAMMA"])).text,
    "personal:alice: 2 earlier facts were consolidated or removed; rely only on the current list.",
  );
});

test("an edited fact withdraws its earlier text even when the new text is not selected", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA")], [], held(["1", "ALPHA"]));
  assert.equal(
    memoryRecallDelta([], [entry(first.record)], held(["1", "ALPHA revised"])).text,
    "personal:alice: 1 earlier fact was consolidated or removed; rely only on the current list.",
  );
});

test("withdrawals never quote facts from a notebook that is no longer readable", () => {
  const first = memoryRecallDelta([fact("1", "PRIVATE_FACT")], [], held(["1", "PRIVATE_FACT"]));
  const result = memoryRecallDelta([], [entry(first.record)], new Map());
  assert.doesNotMatch(result.text, /PRIVATE_FACT|personal:alice/);
  assert.match(result.text, /no longer included/);
});

test("display labels never change the stored checkpoint or earlier bytes", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA")], [], all, new Map([[alice, "Alice"]]));
  const history = [entry(first.record)];
  const before = JSON.stringify(history);
  const next = memoryRecallDelta([fact("1", "ALPHA"), fact("2", "BETA")], history, all, new Map([[alice, "Al"]]));
  assert.equal(next.text, "New or updated memory facts:\n\n### Al\n- (2026-10-01) BETA");
  assert.equal(JSON.stringify(history), before);
});

test("compacting away the recall anchor restores a current baseline", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA")], [], all);
  const history = [entry({ ...first.record, anchorSeq: 1 }, 8)];
  assert.match(memoryRecallDelta([fact("1", "ALPHA")], history, all).text, /ALPHA/);
});

test("recall checkpoint metadata never leaks into attachment-only compaction input", () => {
  const recorded = entry(memoryRecallDelta([fact("1", "CHECKPOINT_ONLY_FACT")], [], all).record);
  recorded.payload = { ...(recorded.payload as Record<string, unknown>), text: "", environment: "file: report.csv" };
  const text = compactTranscript([recorded]);
  assert.match(text, /report.csv/);
  assert.doesNotMatch(text, /CHECKPOINT_ONLY_FACT|memoryRecall/);
});
