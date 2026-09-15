import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the reply follows source messages in the same thread container", () => {
  const page = inbox.match(/function itemPageTpl[\s\S]*?function keepingChatLogsPinned/)?.[0] ?? "";
  assert.match(page, /inbox-item-thread[\s\S]*?\$\{contextTpl\(item\)\}[\s\S]*?\$\{chatTpl\(item\)\}\s*<\/div>/);
  assert.doesNotMatch(page, /<aside/);
});

test("the old sticky side panel and viewport-height sizing are removed", () => {
  assert.doesNotMatch(inbox, /sizeAside|ASIDE_MIN_HEIGHT|ASIDE_MAX_HEIGHT/);
  assert.doesNotMatch(css, /inbox-item-aside|inbox-aside-height/);
});

test("reply history grows in the page rather than a nested scroll panel", () => {
  assert.match(
    css,
    /\.inbox-item-thread > \.inbox-chat \.inbox-chat-log \{[^}]*max-height: none;[^}]*overflow: visible;/,
  );
});

test("inbox reuses the shared composer's autosizing", () => {
  const embedded = readFileSync(new URL("../src/embedded-composer.ts", import.meta.url), "utf8");
  assert.match(inbox, /embeddedComposer\(/);
  assert.match(embedded, /ctx.composer.resizeComposer\(\)/);
  assert.doesNotMatch(inbox, /autosizeChatInput/);
});
