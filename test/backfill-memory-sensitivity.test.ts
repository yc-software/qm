import assert from "node:assert/strict";
import test from "node:test";
import { classifyBatchWithSplit, isCrossScopeRow, needsUpdate } from "../scripts/backfill-memory-sensitivity.ts";

test("isCrossScopeRow recovers self-only, viral-tainted, and legacy empty-source rows", () => {
  assert.equal(
    isCrossScopeRow({ scope_id: "personal:alice", session_scope_id: "personal:alice", sources: ["personal:alice"] }),
    false,
  );
  assert.equal(
    isCrossScopeRow({
      scope_id: "personal:alice",
      session_scope_id: "personal:alice",
      sources: ["personal:alice", "channel:C1", "group:G2", "org"],
    }),
    false,
  );
  assert.equal(
    isCrossScopeRow({
      scope_id: "personal:alice",
      session_scope_id: null,
      sources: ["personal:alice", "channel:C1"],
    }),
    false,
  );
  assert.equal(isCrossScopeRow({ scope_id: "personal:alice", session_scope_id: null, sources: [] }), false);
});

test("isCrossScopeRow skips genuine cross-scope rows", () => {
  assert.equal(
    isCrossScopeRow({ scope_id: "personal:alice", session_scope_id: "channel:C1", sources: ["personal:alice"] }),
    true,
  );
  assert.equal(isCrossScopeRow({ scope_id: "personal:alice", session_scope_id: "channel:C1", sources: [] }), true);
  assert.equal(isCrossScopeRow({ scope_id: "personal:alice", session_scope_id: null, sources: ["channel:C1"] }), true);
  assert.equal(
    isCrossScopeRow({ scope_id: "personal:alice", session_scope_id: null, sources: ["channel:C1", "org"] }),
    true,
  );
  assert.equal(
    isCrossScopeRow({
      scope_id: "personal:alice",
      session_scope_id: null,
      sources: ["personal:alice", "personal:bob"],
    }),
    true,
  );
});

test("needsUpdate flags bloated sources, empty sources, source_unknown, or label change", () => {
  assert.equal(
    needsUpdate(
      { scope_id: "personal:alice", sensitivity: "ordinary", sources: ["personal:alice"], source_unknown: false },
      "ordinary",
    ),
    false,
  );
  assert.equal(
    needsUpdate(
      {
        scope_id: "personal:alice",
        sensitivity: "ordinary",
        sources: ["personal:alice", "channel:C1"],
        source_unknown: false,
      },
      "ordinary",
    ),
    true,
  );
  assert.equal(
    needsUpdate({ scope_id: "personal:alice", sensitivity: "unknown", sources: [], source_unknown: false }, "ordinary"),
    true,
  );
  assert.equal(
    needsUpdate(
      { scope_id: "personal:alice", sensitivity: "sensitive", sources: ["personal:alice"], source_unknown: true },
      "sensitive",
    ),
    true,
  );
});

test("classifyBatchWithSplit splits failing batches and isolates single-row failures", async () => {
  const rows = [
    { id: "1", text: "a" },
    { id: "2", text: "b" },
    { id: "3", text: "c" },
    { id: "4", text: "d" },
  ];
  const errors: string[] = [];
  const results = await classifyBatchWithSplit(
    rows,
    async (texts) => {
      if (texts.length > 2) return { labels: [], error: "unexpected label count" };
      if (texts.includes("c")) return { labels: [], error: "parse error" };
      return { labels: texts.map(() => "ordinary") };
    },
    (batch, error) => errors.push(`${batch.map((r) => r.id).join(",")}:${error}`),
  );
  assert.deepEqual(
    results.map((r) => ({ id: r.row.id, label: r.label, failed: r.failed })),
    [
      { id: "1", label: "ordinary", failed: undefined },
      { id: "2", label: "ordinary", failed: undefined },
      { id: "3", label: undefined, failed: true },
      { id: "4", label: "ordinary", failed: undefined },
    ],
  );
  assert.deepEqual(errors, ["3:parse error"]);
});
