import { test } from "node:test";
import assert from "node:assert/strict";
import { compactTranscript, INTERRUPTED_TOOL_RESULT } from "../src/harness/context-compaction.ts";
import type { SessionEntry } from "../src/types.ts";

function ent(type: SessionEntry["type"], payload: unknown, seq = 0): SessionEntry {
  return { sessionId: "s", seq, parentSeq: null, type, payload, scopeLabel: "org:default-org", createdAt: seq };
}

test("compactTranscript marks an interrupted tool call (no recorded result) so the summarizer sees the gap", () => {
  const out = compactTranscript([
    ent("user", { text: "refresh the dashboard" }, 1),
    ent("tool_call", { tool: "execute", command: "bash refresh.sh", callId: "c1" }, 2),
    ent("user", { text: "(system note: the platform restarted mid-turn...)" }, 3),
  ]);
  assert.match(out, /tool_result#2: \[interrupted/);
  assert.ok(out.includes(INTERRUPTED_TOOL_RESULT));
});

test("compactTranscript does NOT mark a tool call that has a recorded result", () => {
  const out = compactTranscript([
    ent("tool_call", { tool: "execute", command: "bash refresh.sh", callId: "c1" }, 1),
    ent("tool_result", { tool: "execute", callId: "c1", result: "wrote inv=89", isError: false }, 2),
  ]);
  assert.doesNotMatch(out, /interrupted/);
  assert.match(out, /wrote inv=89/);
});

test("compactTranscript leaves legacy tool calls without a callId untouched (no false interrupted marker)", () => {
  const out = compactTranscript([ent("tool_call", { tool: "read", path: "a.txt" }, 1)]);
  assert.doesNotMatch(out, /interrupted/);
});

test("compactTranscript labels overheard entries by author and keeps a file-only one's caption", () => {
  const out = compactTranscript([
    ent("user", { overheard: true, ts: "1", name: "Alice", text: "I posted a chart" }, 1),
    ent("user", { overheard: true, ts: "2", name: "Bob", text: "", files: ["selfie.jpg"] }, 2),
    ent("user", { text: "whose selfie is that?" }, 3),
  ]);
  assert.match(out, /overheard#1 \(Alice\): I posted a chart/);
  assert.match(out, /overheard#2 \(Bob\): \(shared file\) \(files: selfie\.jpg\)/);
  assert.match(out, /user#3: whose selfie is that\?/);
});

test("compactTranscript bounds a giant entry payload, hoisting isError out of the JSON", () => {
  const out = compactTranscript([
    ent(
      "tool_result",
      { tool: "execute", callId: "c1", stdout: "x".repeat(900_000), isError: true, result: "tail: [exit 1]" },
      1,
    ),
  ]);
  assert.ok(out.length <= 16_000, `line stays within the declared cap (got ${out.length} chars)`);
  assert.ok(out.includes("…[truncated —"), "truncation is marked with the original size");
  assert.ok(out.startsWith("tool_result#1: [isError]"), "failure status survives regardless of JSONB key order");
  assert.ok(out.includes("[exit 1]"), "the payload tail survives the cut");
});

test("compactTranscript bounds a giant text entry too", () => {
  const out = compactTranscript([ent("user", { text: `start ${"x".repeat(900_000)} end` }, 1)]);
  assert.ok(out.length <= 16_000, `line stays within the declared cap (got ${out.length} chars)`);
  assert.ok(out.startsWith("user#1: start ") && out.endsWith(" end"), "head and tail of the text survive");
});

test("compactTranscript bounds a giant prior-summary line and a giant overheard file list", () => {
  const out = compactTranscript([
    ent("system", { kind: "context_summary", throughSeq: 3, text: "s".repeat(900_000) }, 1),
    ent(
      "user",
      { overheard: true, name: "ada", text: "hi", files: Array.from({ length: 5_000 }, (_, i) => `file-${i}.txt`) },
      2,
    ),
  ]);
  for (const line of out.split("\n"))
    assert.ok(line.length <= 16_000, `every line is bounded (got ${line.length} chars)`);
});
