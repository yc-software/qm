import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the loaded conversation renders one assistant beside the source thread", () => {
  const page = inbox.match(/function itemPageTpl[\s\S]*?function keepingChatLogsPinned/)?.[0] ?? "";
  assert.match(
    page,
    /\$\{contextTpl\(item\)\}\s*\$\{draftMessageTpl\(item\)\}[\s\S]*?inbox-item-thread[\s\S]*?\$\{detail\}[\s\S]*?item.detailLoaded && !usesOutputReview\(item\)[\s\S]*?<aside class="inbox-item-aside" aria-label="Conversation assistant">\$\{chatTpl\(item\)\}<\/aside>/,
  );
  assert.equal(page.match(/chatTpl\(item\)/g)?.length, 1);
});

test("desktop threads use a CSS-sized sticky assistant in the second column", () => {
  assert.doesNotMatch(inbox, /sizeAside|ASIDE_MIN_HEIGHT|ASIDE_MAX_HEIGHT/);
  assert.match(css, /@media \(min-width: 1100px\) \{\s*\.inbox-thread-page/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) var\(--content-aside-width\);/);
  assert.match(css, /\.inbox-item-aside \{[^}]*grid-area: 1 \/ 2 \/ span 2;[^}]*position: sticky;/);
  assert.match(css, /\.inbox-item-aside \.inbox-chat-log \{[^}]*flex: 1;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
});

test("narrow layouts keep the assistant below the source with page scrolling", () => {
  const stacked = css.slice(0, css.indexOf("@media (min-width: 1100px) {\n  .inbox-thread-page"));
  assert.match(stacked, /\.inbox-item-aside \{[^}]*width: min\(var\(--content-wide-width\), 100%\);/);
  assert.match(stacked, /\.inbox-item-aside \.inbox-chat-log \{[^}]*max-height: none;[^}]*overflow: visible;/);
});

test("inbox reuses the shared composer's autosizing", () => {
  const embedded = readFileSync(new URL("../src/embedded-composer.ts", import.meta.url), "utf8");
  assert.match(inbox, /embeddedComposer\(/);
  assert.match(embedded, /ctx.composer.resizeComposer\(\)/);
  assert.doesNotMatch(inbox, /autosizeChatInput/);
});
