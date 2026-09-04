import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const requireFromMiniLit = createRequire(fileURLToPath(import.meta.resolve("@mariozechner/mini-lit")));
const { marked } = requireFromMiniLit("marked") as typeof import("marked");

test("approximation tildes in prose do not become strikethrough", () => {
  const out = marked.parse("pulled all ~380 file mutations. That gets a partial `server.js` (~1,900 of 3,042 lines)", {
    async: false,
  });
  assert.ok(!out.includes("<del>"), `lone ~ pair rendered as strikethrough: ${out}`);
});

test("single tilde before a number does not open a strikethrough", () => {
  const out = marked.parse("takes ~5 minutes, costs ~10 dollars", { async: false });
  assert.ok(!out.includes("<del>"), `lone ~ pair rendered as strikethrough: ${out}`);
});

test("real double-tilde strikethrough still renders", () => {
  const out = marked.parse("this is ~~struck~~ text", { async: false });
  assert.ok(out.includes("<del>struck</del>"));
});
