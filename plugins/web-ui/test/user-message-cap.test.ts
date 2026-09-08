import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const shared = readFileSync(new URL("../src/shared-session.ts", import.meta.url), "utf8");

const pinned = String.raw`\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) \.user-bubble`;

test("only the pinned prompt is capped, at 40% of its own scroller, and its text and chips shrink", () => {
  const bubble = css.match(new RegExp(String.raw`\n${pinned} \{[^}]*\}`))?.[0] ?? "";
  assert.match(bubble, /max-height: 40cqh;/);
  assert.match(bubble, /flex-direction: column;/);
  const text =
    css.match(new RegExp(String.raw`\n${pinned} > markdown-block,\n${pinned} > \.slack-wire-text \{[^}]*\}`))?.[0] ??
    "";
  assert.match(text, /flex-shrink: 1000;/);
  assert.match(text, /overflow: hidden;/);
  const files = css.match(new RegExp(String.raw`\n${pinned} > \.message-files \{[^}]*\}`))?.[0] ?? "";
  assert.match(files, /min-height: 0;/);
  assert.match(files, /max-height: 20cqh;/);
  assert.match(files, /overflow-y: auto;/);
  const base = css.match(/\n\.user-bubble \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(base, /max-height|flex/);
});

test("the scroller is the size container the cap measures, except the content-sized mini convo", () => {
  assert.match(css, /\n\.chat-scroll \{[^}]*container-type: size;/);
  const mini = css.match(/\n\.mini-convo-body \.chat-scroll \{[^}]*\}/)?.[0] ?? "";
  assert.match(mini, /container-type: normal;/);
  assert.match(css, new RegExp(String.raw`\n\.mini-convo-body ${pinned} \{[^}]*max-height: 100px;`));
  assert.match(css, /\n\.readonly-chat \.custom-chat-shell \{[^}]*flex-direction: column;/);
  assert.match(css, /\n\.readonly-chat \.chat-scroll \{[^}]*flex: 1;/);
  assert.doesNotMatch(chat, /--chat-viewport/);
});

test("images a user attached render as chips, not inline, in the live chat", () => {
  const fn = chat.match(/function userAttachmentBadge\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(fn, /startsWith\("image\/"\)/);
  assert.match(
    fn,
    /return chipBadge\(FileImage, a\.fileName, a\.size, artifactHref \?\? dataUrl \?\? undefined, download\);/,
  );
  assert.doesNotMatch(fn, /<img/);
  assert.match(fn, /const download = !artifactHref \|\| !browserRenderableImage\(a\.mimeType\);/);
});

test("images a user attached render as chips that open inline on the share page", () => {
  const files = shared.match(/message\.attachments\.map\(\(file\) => \{[\s\S]*?\n\s*\}\)\}/)?.[0] ?? "";
  assert.match(files, /if \(inlineImage && message\.role !== "user"\) \{\s*return html`<a\s+class="file-image"/);
  assert.equal(files.match(/<img/g)?.length, 1);
  assert.match(
    files,
    /return chipBadge\(\s*inlineImage \? FileImage : File,\s*file\.name,\s*file\.sizeBytes,\s*inlineImage \? `\$\{href\}\?inline=1` : href,\s*!inlineImage,?\s*\);/,
  );
});
