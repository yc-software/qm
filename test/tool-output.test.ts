import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cutToolOutput,
  createMemoryToolOutputStore,
  DEFAULT_INLINE_TOKENS,
  inlineTokensFrom,
  toolOutputCallId,
} from "../src/sessions/tool-output.ts";
import type { SessionEntry } from "../src/types.ts";

test("the inline cap setting: unset means 4096 tokens, 0 means off, junk falls back", () => {
  assert.equal(inlineTokensFrom(undefined), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom(null), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom(0), 0);
  assert.equal(inlineTokensFrom("2048"), 2048);
  assert.equal(inlineTokensFrom(-1), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom({}), DEFAULT_INLINE_TOKENS);
});

test("cutToolOutput keeps text within the budget untouched and halves the rest between head and tail", () => {
  assert.equal(cutToolOutput("short", 10, "c1"), null);
  assert.equal(cutToolOutput("x".repeat(1_000), 0, "c1"), null);
  const text = "H".repeat(500) + "T".repeat(500);
  const cut = cutToolOutput(text, 50, "c1")!;
  assert.equal(cut.shownChars, 200);
  assert.ok(cut.text.startsWith("H".repeat(100)));
  assert.ok(cut.text.endsWith("T".repeat(100)));
  assert.match(cut.text, /tool-output\/c1/);
});

test("tool-output paths name one call", () => {
  assert.equal(toolOutputCallId("tool-output/toolu_1"), "toolu_1");
  assert.equal(toolOutputCallId("tool-output/"), null);
  assert.equal(toolOutputCallId("tool-output/a/b"), null);
  assert.equal(toolOutputCallId("notes/tool-output/a"), null);
});

test("a parked result reads back only through its own session's tool result", async () => {
  const entries: SessionEntry[] = [];
  const store = createMemoryToolOutputStore({ sessions: { getEntries: async (id) => (id === "s1" ? entries : []) } });
  const blob = await store.save("the whole thing");
  entries.push({
    sessionId: "s1",
    seq: 0,
    parentSeq: null,
    type: "tool_result",
    payload: { tool: "execute", callId: "c1", result: "the…", output: { blob, chars: 15, shownChars: 4 } },
    scopeLabel: "personal:u",
    createdAt: 1,
  });
  assert.deepEqual(await store.read("s1", "c1"), { text: "the whole thing" });
  assert.equal(await store.read("s2", "c1"), null);
  assert.equal(await store.read("s1", "c2"), null);
});
