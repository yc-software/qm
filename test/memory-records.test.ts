import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyMemoryRecords, updateMemoryRecords, restoreMemoryRecords } from "../src/memory/records.ts";

const scope = "personal:alice";

test("legacy prose, headings and multiline facts remain unclassified with stable IDs", () => {
  const body = "# Private heading\n\nFreeform prose\ncontinued\n\n- fact\n  continuation\n* other fact\n";
  const snapshot = legacyMemoryRecords(scope, body);
  assert.equal(snapshot.records.length, 4);
  assert.deepEqual(snapshot, legacyMemoryRecords(scope, body));
  assert.ok(
    snapshot.records.every(
      (record) => record.sensitivity === "unknown" && record.sourceUnknown && !record.sources.length,
    ),
  );
  assert.match(snapshot.records[2]!.text, /continuation/);
});

test("capture records origin and session rather than destination notebook", () => {
  const result = updateMemoryRecords(scope, { version: 1, records: [] }, "- new fact", {
    conversationScopeId: "channel:source",
    sessionId: "session-a",
    sensitivity: "ordinary",
    inheritedRecords: [],
  });
  assert.deepEqual(result.records[0]!.sources, [{ scopeId: "channel:source", sessionId: "session-a" }]);
  assert.equal(result.records[0]!.sensitivity, "ordinary");
  assert.equal(result.records[0]!.sourceUnknown, false);
});

test("capture without trusted dependency information remains incomplete", () => {
  const result = updateMemoryRecords(scope, { version: 1, records: [] }, "- new fact", { sensitivity: "ordinary" });
  assert.equal(result.records[0]!.sourceUnknown, true);
});

test("rewrites preserve unchanged IDs and conservatively inherit sources and sensitivity", () => {
  const captured = updateMemoryRecords(scope, { version: 1, records: [] }, "- restricted fact\n- another fact", {
    conversationScopeId: "group:private",
    sensitivity: "restricted",
    inheritedRecords: [],
  });
  const rewritten = updateMemoryRecords(scope, captured, "- summary\n- another fact");
  assert.equal(rewritten.records[1]!.id, captured.records[1]!.id);
  assert.equal(rewritten.records[0]!.sensitivity, "restricted");
  assert.deepEqual(rewritten.records[0]!.sources, captured.records[0]!.sources);
  assert.equal(rewritten.records[0]!.sourceUnknown, true);
});

test("capture inherits restrictions even when caller suggests ordinary", () => {
  const restricted = updateMemoryRecords(scope, { version: 1, records: [] }, "- restricted fact", {
    conversationScopeId: "group:private",
    sensitivity: "restricted",
    inheritedRecords: [],
  });
  const copied = updateMemoryRecords("group:other", { version: 1, records: [] }, "- rewritten fact", {
    conversationScopeId: "group:other",
    sensitivity: "ordinary",
    inheritedRecords: restricted.records,
  });
  assert.equal(copied.records[0]!.sensitivity, "restricted");
  assert.deepEqual(
    copied.records[0]!.sources.map((source) => source.scopeId),
    ["group:private", "group:other"],
  );
});

test("unknown legacy provenance cannot be cleared by capture or rewrite", () => {
  const legacy = legacyMemoryRecords(scope, "- legacy fact");
  const copied = updateMemoryRecords(scope, { version: 1, records: [] }, "- paraphrased", {
    sensitivity: "ordinary",
    inheritedRecords: legacy.records,
  });
  assert.equal(copied.records[0]!.sensitivity, "unknown");
  assert.equal(copied.records[0]!.sourceUnknown, true);
  assert.equal(updateMemoryRecords(scope, legacy, "- reworded").records[0]!.sourceUnknown, true);
});

test("restore cannot downgrade restrictions introduced after the old revision", () => {
  const old = updateMemoryRecords(scope, { version: 1, records: [] }, "- original", {
    sensitivity: "ordinary",
    inheritedRecords: [],
  });
  const current = updateMemoryRecords(scope, old, "- changed", {
    sensitivity: "restricted",
    conversationScopeId: "group:source",
    inheritedRecords: old.records,
  });
  const restored = restoreMemoryRecords(current, old);
  assert.equal(restored.records[0]!.id, old.records[0]!.id);
  assert.equal(restored.records[0]!.sensitivity, "restricted");
  assert.deepEqual(
    new Set(restored.records[0]!.sources.map((source) => source.scopeId)),
    new Set([scope, "group:source"]),
  );
});

test("duplicate text blocks retain distinct record IDs and unchanged snapshots are stable", () => {
  const old = legacyMemoryRecords(scope, "- repeated\n- repeated");
  const next = updateMemoryRecords(scope, old, "- repeated\n- repeated");
  assert.deepEqual(next, old);
  assert.notEqual(next.records[0]!.id, next.records[1]!.id);
  assert.deepEqual(updateMemoryRecords(scope, old, ""), { version: 1, records: [] });
});

test("rewrite contraction cannot discard stronger duplicate or reworded-away provenance", () => {
  const ordinary = updateMemoryRecords(scope, { version: 1, records: [] }, "- Same fact", {
    sensitivity: "ordinary",
    inheritedRecords: [],
  }).records[0]!;
  const restricted = updateMemoryRecords(scope, { version: 1, records: [] }, "- Same fact", {
    sensitivity: "restricted",
    conversationScopeId: "group:private",
    inheritedRecords: [],
  }).records[0]!;
  for (const records of [
    [ordinary, restricted],
    [restricted, ordinary],
    [ordinary, { ...restricted, text: "- Different wording" }],
  ]) {
    const merged = updateMemoryRecords(scope, { version: 1, records }, "- Same fact");
    assert.equal(merged.records[0]!.sensitivity, "restricted");
    assert.ok(merged.records[0]!.sources.some((source) => source.scopeId === "group:private"));
  }
});
