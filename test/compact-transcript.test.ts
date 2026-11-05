import { test } from "node:test";
import assert from "node:assert/strict";
import { compactTranscript, INTERRUPTED_TOOL_RESULT } from "../src/agent/context-compaction.ts";
import { type NewItem, storedItem } from "../src/sessions/items.ts";

function at(item: NewItem, seq = 0, createdAt = 0) {
  return storedItem(item, { sessionId: "s", seq, createdAt });
}

const NOON = Date.UTC(2026, 6, 29, 12, 0);

test("compactTranscript marks an interrupted tool call (no recorded result) so the summarizer sees the gap", () => {
  const out = compactTranscript([
    at({ kind: "UserMessage", text: "refresh the dashboard" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "bash refresh.sh" } }, 2),
    at({ kind: "UserMessage", text: "(system note: the platform restarted mid-turn...)" }, 3),
  ]);
  assert.match(out, /ToolResult for ToolCall#2 \(none recorded\): \[system\] This call was interrupted/);
  assert.ok(out.includes(INTERRUPTED_TOOL_RESULT));
});

test("compactTranscript does NOT mark a tool call that has a recorded result", () => {
  const out = compactTranscript([
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "bash refresh.sh" } }, 1),
    at({ kind: "ToolResult", callId: "c1", tool: "execute", text: "wrote inv=89", isError: false }, 2),
  ]);
  assert.doesNotMatch(out, /interrupted/);
  assert.match(out, /wrote inv=89/);
});

test("compactTranscript leaves legacy tool calls without a callId untouched (no false interrupted marker)", () => {
  const out = compactTranscript([at({ kind: "ToolCall", callId: "", tool: "read", body: { path: "a.txt" } }, 1)]);
  assert.doesNotMatch(out, /interrupted/);
});

test("compactTranscript labels overheard entries by author and keeps a file-only one's caption", () => {
  const out = compactTranscript([
    at({ kind: "UserMessage", text: "I posted a chart", externalId: "1", body: { overheard: true, name: "Alice" } }, 1),
    at({ kind: "UserMessage", externalId: "2", body: { overheard: true, name: "Bob", files: ["selfie.jpg"] } }, 2),
    at({ kind: "UserMessage", text: "whose selfie is that?" }, 3),
  ]);
  assert.match(out, /overheard#1 \(Alice\): I posted a chart/);
  assert.match(out, /overheard#2 \(Bob\): \(shared file\) \(files: selfie\.jpg\)/);
  assert.match(out, /UserMessage#3: whose selfie is that\?/);
});

test("compactTranscript bounds a giant entry payload, hoisting isError out of the JSON", () => {
  const out = compactTranscript([
    at(
      {
        kind: "ToolResult",
        callId: "c1",
        tool: "execute",
        isError: true,
        text: "tail: [exit 1]",
        body: { stdout: "x".repeat(900_000) },
      },
      1,
    ),
  ]);
  assert.ok(out.length <= 16_000, `line stays within the declared cap (got ${out.length} chars)`);
  assert.ok(out.includes("…[truncated —"), "truncation is marked with the original size");
  assert.ok(out.startsWith("ToolResult#1: [isError]"), "failure status survives regardless of JSONB key order");
  assert.ok(out.includes("[exit 1]"), "the payload tail survives the cut");
});

test("compactTranscript bounds a giant text entry too", () => {
  const out = compactTranscript([at({ kind: "UserMessage", text: `start ${"x".repeat(900_000)} end` }, 1)]);
  assert.ok(out.length <= 16_000, `line stays within the declared cap (got ${out.length} chars)`);
  assert.ok(out.startsWith("UserMessage#1: start ") && out.endsWith(" end"), "head and tail of the text survive");
});

test("compactTranscript bounds a giant prior-summary line and a giant overheard file list", () => {
  const out = compactTranscript([
    at({ kind: "ContextCompaction", throughSeq: 3, text: "s".repeat(900_000) }, 1),
    at(
      {
        kind: "UserMessage",
        text: "hi",
        body: { overheard: true, name: "ada", files: Array.from({ length: 5_000 }, (_, i) => `file-${i}.txt`) },
      },
      2,
    ),
  ]);
  for (const line of out.split("\n"))
    assert.ok(line.length <= 16_000, `every line is bounded (got ${line.length} chars)`);
});

test("compactTranscript stamps every line with its entry's UTC timestamp", () => {
  const out = compactTranscript([
    at({ kind: "UserMessage", text: "refresh the dashboard", body: { name: "sam" } }, 1, NOON),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "bash refresh.sh" } }, 2, NOON + 60_000),
    at({ kind: "ToolResult", callId: "c1", tool: "execute", text: "ok", isError: false }, 3, NOON + 120_000),
    at(
      { kind: "UserMessage", text: "lunch?", externalId: "1", body: { overheard: true, name: "Bob" } },
      4,
      NOON + 180_000,
    ),
  ]);
  assert.match(out, /^UserMessage#1 2026-07-29T12:00Z \(sam\): refresh the dashboard$/m);
  assert.match(out, /^ToolCall#2 2026-07-29T12:01Z: /m);
  assert.match(out, /^ToolResult#3 2026-07-29T12:02Z: /m);
  assert.match(out, /^overheard#4 2026-07-29T12:03Z \(Bob\): lunch\?$/m);
});

test("compactTranscript stamps a chained prior summary with when it was written", () => {
  const out = compactTranscript([at({ kind: "ContextCompaction", throughSeq: 21, text: "earlier work" }, 22, NOON)]);
  assert.equal(out, "Prior summary through seq 21 (written 2026-07-29T12:00Z): earlier work");
});

test("compactTranscript omits the stamp when an entry has no real timestamp", () => {
  const out = compactTranscript([
    at({ kind: "UserMessage", text: "hello" }, 1, 0),
    at({ kind: "UserMessage", text: "again" }, 2, Number.NaN),
  ]);
  assert.match(out, /^UserMessage#1: hello$/m);
  assert.match(out, /^UserMessage#2: again$/m);
});

test("a tool_result marked interrupted still leaves its call reported as interrupted in the compaction transcript", () => {
  const out = compactTranscript([
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make" } }, 1, 1),
    at({ kind: "ToolResult", callId: "c1", text: "[exit 143]", body: { interrupted: true } }, 2, 2),
  ]);
  assert.ok(out.includes(`ToolResult for ToolCall#1 (none recorded): ${INTERRUPTED_TOOL_RESULT}`));
});
