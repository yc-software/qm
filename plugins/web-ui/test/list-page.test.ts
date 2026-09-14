import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("list search uses its purpose as an accessible name", () => {
  const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
  assert.match(source, /aria-label=\$\{o\.search!\.placeholder/);
});

test("empty lists hide search and can carry a hint", () => {
  const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
  assert.match(source, /const showSearch = Boolean\(o\.search\) && \(o\.rows\.length > 0 \|\| searching\)/);
  assert.match(source, /emptyHint\?: string/);
  assert.match(source, /class="empty compact empty-state-block"/);
});
