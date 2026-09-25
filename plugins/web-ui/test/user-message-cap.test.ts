import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const shared = readFileSync(new URL("../src/shared-session.ts", import.meta.url), "utf8");

test("only the collapsed pinned prompt is capped and overflow clips instead of nesting scrollbars", () => {
  const bubble =
    css.match(
      /\.message-stack\s+\.user-row\.latest-prompt:not\(\.pin-expanded\)\s+\.user-bubble\s+>\s+\.pin-content \{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(bubble, /-webkit-line-clamp: 6;/);
  assert.match(bubble, /overflow: hidden;/);
  assert.doesNotMatch(css, /\.user-bubble > (?:markdown-block|\.slack-wire-text)\s*\{/);
  const base = css.match(/\n\.user-bubble \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(base, /max-height|flex/);
});

test("the scroller is the size container the cap measures", () => {
  assert.match(css, /\n\.chat-scroll \{[^}]*container-type: size;/);
  assert.match(css, /\n\.readonly-chat \.custom-chat-shell \{[^}]*flex-direction: column;/);
  assert.match(css, /\n\.readonly-chat \.chat-scroll \{[^}]*flex: 1;/);
  assert.doesNotMatch(chat, /--chat-viewport/);
});

test("user images have inline previews before and after persistence", () => {
  const fn = chat.match(/function userAttachmentBadge\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(fn, /artifactHref \?\? localContentUrl\(a\) \?\? dataUrl/);
  assert.match(fn, /href && browserRenderableImage\(a\.mimeType\)/);
  assert.match(fn, /<img src=\$\{href\} alt=\$\{a\.fileName\}/);
  assert.match(fn, /return chipBadge\(FileImage/);
});

test("shared images open the original through the inline endpoint", () => {
  assert.match(shared, /const inlineImage = sharedInlineImage\(file\.mimetype\)/);
  assert.match(shared, /if \(inlineImage\) \{/);
  assert.doesNotMatch(shared, /inlineImage && message.role/);
  assert.match(shared, /href=\$\{`\$\{href\}\?inline=1`\} target="_blank"/);
  assert.doesNotMatch(shared, /download=\$\{file.name\}/);
});

test("both transcript renderers provide an accessible control and an observable inner body", () => {
  for (const source of [chat, shared]) {
    assert.match(source, /pin-content/);
    assert.match(source, /class="pin-toggle" type="button" hidden aria-expanded="false"/);
  }
  assert.match(shared, /viewport\.sync\(document\.querySelector<HTMLElement>\("\.chat-scroll"\)\)/);
  assert.match(css, /\.deleted-bubble > \.pin-content > :not\(\.revision-badge\) \{\s*text-decoration: line-through;/);
});
