import { test } from "node:test";
import assert from "node:assert/strict";
import { searchSessionEntries } from "../src/sessions/history-search.ts";
import { createContextSummaryPayload } from "../src/harness/context-compaction.ts";
import { createPiTools } from "../src/harness/pi-tools.ts";
import type { SessionEntry } from "../src/types.ts";

const entry = (seq: number, type: SessionEntry["type"], payload: unknown): SessionEntry => ({
  sessionId: "s1",
  seq,
  parentSeq: null,
  type,
  payload,
  scopeLabel: "personal:U1",
  createdAt: 1_700_000_000_000 + seq * 1000,
});

const ENTRIES: SessionEntry[] = [
  entry(1, "user", { text: "where is the Q2 budget doc?" }),
  entry(2, "assistant", { text: "The budget doc lives at shared/q2.md" }),
  entry(3, "tool_call", { tool: "read", path: "shared/q2.md" }),
  entry(4, "user", { text: "now about that other thing" }),
  entry(5, "user", { text: "budget update: approved" }),
];

test("all terms must match, case-insensitively", () => {
  const hits = searchSessionEntries(ENTRIES, "BUDGET doc");
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => /budget/i.test(h) && /doc/i.test(h)));
  assert.equal(searchSessionEntries(ENTRIES, "budget nonexistent").length, 0);
});

test("returns newest-first, tagged type#seq, and honors limit", () => {
  const hits = searchSessionEntries(ENTRIES, "budget", 2);
  assert.equal(hits.length, 2);
  assert.match(hits[0]!, /^user#5 /);
  assert.match(hits[1]!, /^assistant#2 /);
});

test("matches non-text payloads via their JSON (tool calls) and compaction summaries via their text", () => {
  assert.match(searchSessionEntries(ENTRIES, "q2.md read")[0]!, /^tool_call#3 /);
  const withSummary = [entry(6, "system", createContextSummaryPayload(5, "earlier: discussed the offsite venue"))];
  assert.match(searchSessionEntries(withSummary, "offsite venue")[0]!, /offsite venue/);
});

test("empty/whitespace query matches nothing; long hits are clipped", () => {
  assert.equal(searchSessionEntries(ENTRIES, "   ").length, 0);
  const long = [entry(1, "user", { text: `needle ${"x".repeat(600)}` })];
  const hit = searchSessionEntries(long, "needle")[0]!;
  assert.ok(hit.length < 650 && hit.endsWith("…"));
});

test("author travels with the line — the Raphael/Aaron misattribution regression", () => {
  const entries: SessionEntry[] = [
    entry(1, "user", { name: "raphael", text: "Paper trail: Aaron and I honed in on Wed July 15" }),
    entry(2, "user", { name: "eve", overheard: true, text: "what about availability" }),
  ];
  const byText = searchSessionEntries(entries, "july 15");
  assert.match(byText[0]!, /user#1 \([^)]+\) raphael: Paper trail/);
  assert.equal(searchSessionEntries(entries, "raphael").length, 1);
  assert.match(searchSessionEntries(entries, "raphael")[0]!, /raphael: Paper trail/);
  assert.match(searchSessionEntries(entries, "availability")[0]!, /user#2 \([^)]+\) eve: what about/);
});

test("non-human entries carry no author label (assistant/tool are self-evident by type)", () => {
  const entries: SessionEntry[] = [
    entry(1, "assistant", { text: "here is the budget answer" }),
    entry(2, "tool_call", { tool: "read", path: "q2.md" }),
  ];
  assert.match(searchSessionEntries(entries, "budget")[0]!, /^assistant#1 \([^)]+\): here is/);
  assert.match(searchSessionEntries(entries, "q2.md")[0]!, /^tool_call#2 \([^)]+\): /);
});

test("history tool returns formatted hits and a clear no-match message", async () => {
  const tools = createPiTools({
    current: {
      history: async (q: string) =>
        q.includes("budget") ? ["user#5 (2023-11-14T22:13:25.000Z): budget update: approved"] : [],
    } as any,
    emit: () => {},
    scopeLabel: "personal:U1",
  });
  const history = tools.find((t) => t.name === "history");
  assert.ok(history);
  const run = (params: unknown) =>
    (history.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>)("t", params);
  assert.match((await run({ query: "budget" })).content[0]!.text, /budget update: approved/);
  assert.match((await run({ query: "zilch" })).content[0]!.text, /nothing in this conversation's transcript matches/);
});
