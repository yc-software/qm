import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import "../src/marked-dedupe.ts";

type Ext = { name: string; level: "inline"; start: (s: string) => number; tokenizer: () => undefined };
const ext = (name: string): Ext => ({
  name,
  level: "inline",
  start: (s) => s.indexOf("%"),
  tokenizer: () => undefined,
});
const inlineCount = (): number =>
  (marked.defaults as { extensions?: { inline?: unknown[] } }).extensions?.inline?.length ?? 0;

test("re-registering the same extensions is a no-op — the tokenizer list stops growing", () => {
  marked.use({ extensions: [ext("dedupe-a"), ext("dedupe-b")] });
  const after = inlineCount();
  assert.ok(after >= 2, "first registration lands");
  for (let i = 0; i < 50; i++) marked.use({ extensions: [ext("dedupe-a"), ext("dedupe-b")] });
  assert.equal(inlineCount(), after);
});

test("a config carrying more than extensions always passes through", () => {
  marked.use({ extensions: [ext("dedupe-c")] });
  const before = inlineCount();
  marked.use({ extensions: [ext("dedupe-c")], breaks: false });
  assert.equal(inlineCount(), before + 1, "extension-plus-options config is not swallowed");
});

test("a config with no extensions passes through untouched", () => {
  marked.use({ breaks: false });
  assert.equal((marked.defaults as { breaks?: boolean }).breaks, false);
});

test("a partially-new extension list registers", () => {
  marked.use({ extensions: [ext("dedupe-a"), ext("dedupe-new")] });
  assert.match(marked.parse("hello *world*") as string, /<em>world<\/em>/);
});
