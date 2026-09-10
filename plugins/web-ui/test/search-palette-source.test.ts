import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const search = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");
const searchCss = readFileSync(new URL("../src/styles/search.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("result rows carry the speaker avatar, the highlighted snippet, and a machine-readable time", () => {
  assert.match(search, /class="chat-search-who \$\{hit\.entryType === "user" \? "user" : "agent"\}"/);
  assert.match(search, /class="chat-search-snippet" dir="auto">\$\{highlight\(hitSnippet\(hit\)\)\}/);
  assert.match(search, /<time\s+datetime=\$\{new Date\(hit\.createdAt\)\.toISOString\(\)\}/);
  assert.match(
    searchCss,
    /\.chat-search-meta time \{\s*font-family: var\(--font-mono\);\s*font-variant-numeric: tabular-nums;/,
  );
});

test("searching reuses the thinking shimmer and never throws on a missing timestamp", () => {
  assert.match(search, /class="chat-search-empty sheen-label thinking-sheen">Searching…</);
  assert.doesNotMatch(search, /spinner|chat-search-searching/);
  assert.doesNotMatch(searchCss, /chat-search-searching|shimmer-text/);
  assert.match(shell, /@keyframes shimmer-text/);
  assert.match(search, /Number\.isFinite\(hit\.createdAt\)\s*\?\s*html`<time datetime=/);
});

test("the palette keeps its dialog semantics and keyboard contract", () => {
  assert.match(
    search,
    /class="chat-search-palette" role="dialog" aria-label="Search your chats" @keydown=\$\{onPaletteKeydown\}/,
  );
  for (const key of ["Escape", "ArrowDown", "ArrowUp", "Enter"]) {
    assert.match(search, new RegExp(`e\\.key === "${key}"`));
  }
  assert.match(search, /e\.key\.toLowerCase\(\) === "k" && \(isMac \? e\.metaKey : e\.ctrlKey\)/);
  assert.match(search, /if \(e\.metaKey \|\| e\.ctrlKey\) return void askQm\(\);/);
  assert.match(shell, /\.chat-search-row\.selected \{\s*background: var\(--hover\);/);
});
