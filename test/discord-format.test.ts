import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMessage, DISCORD_MESSAGE_LIMIT } from "../src/discord/format.ts";

const fences = (s: string): number => (s.match(/^```/gm) ?? []).length;

test("short text is one chunk", () => {
  assert.deepEqual(chunkMessage("hello"), ["hello"]);
});

test("empty text is no chunks", () => {
  assert.deepEqual(chunkMessage("   "), []);
});

test("long prose splits on paragraph boundaries under the limit", () => {
  const para = "word ".repeat(150).trim();
  const text = Array.from({ length: 6 }, () => para).join("\n\n");
  const chunks = chunkMessage(text);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= DISCORD_MESSAGE_LIMIT, `chunk of ${c.length}`);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});

test("a code block split across chunks is closed and reopened", () => {
  const code = Array.from({ length: 200 }, (_, i) => `    line_${i} = ${i}`).join("\n");
  const text = `intro\n\n\`\`\`python\n${code}\n\`\`\`\n\noutro`;
  const chunks = chunkMessage(text);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= DISCORD_MESSAGE_LIMIT);
    assert.equal(fences(c) % 2, 0, `unbalanced fences in:\n${c.slice(0, 80)}`);
  }
  assert.ok(chunks[1]!.startsWith("```python\n"));
  assert.ok(chunks.some((c) => c.includes("    line_199 = 199")));
});

test("an unbroken run longer than the limit is hard-cut", () => {
  const chunks = chunkMessage("x".repeat(4500));
  assert.deepEqual(
    chunks.map((c) => c.length),
    [2000, 2000, 500],
  );
});

test("an oversized fence opening line still terminates and respects the limit", () => {
  const text = "```" + "a".repeat(2100) + "\n" + "body line\n".repeat(300) + "```";
  const chunks = chunkMessage(text);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= DISCORD_MESSAGE_LIMIT, `chunk of ${c.length}`);
  assert.ok(chunks.join("\n").includes("body line"));
});

test("an unbroken run of emoji is never cut between surrogate halves", () => {
  const chunks = chunkMessage(`a${"😀".repeat(1500)}`);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= DISCORD_MESSAGE_LIMIT);
    assert.equal(c, [...c].join(""));
    assert.ok(!/[\ud800-\udbff]$/.test(c) && !/^[\udc00-\udfff]/.test(c));
  }
  assert.equal(chunks.join(""), `a${"😀".repeat(1500)}`);
});
