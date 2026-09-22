import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

const block = (selector: RegExp): string => css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

test("a user image carries its name and size inside the same element as the thumbnail", () => {
  const fn = chat.match(/function userAttachmentBadge\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(
    fn,
    /class="file-image"[\s\S]*?<img src=\$\{href\}[\s\S]*?class="file-image-name"[\s\S]*?class="file-image-size"/,
  );
  assert.match(css, /\.file-image \.file-image-name,\s*\.file-image \.file-image-size \{\s*display: none;/);
});

test("the thumbnail folds to a chip in a short pane and while the prompt is pinned", () => {
  const short =
    css.match(
      /@container split-pane \(max-height: 480px\) \{\s*\.user-row > \.message-files \.file-image \{([^}]*)\}/,
    )?.[1] ?? "";
  const stuck = block(/\.message-stack \.user-row\.stuck > \.message-files \.file-image/);
  for (const [name, rule] of [
    ["short pane", short],
    ["pinned prompt", stuck],
  ] as const) {
    assert.match(rule, /--attachment-compact: 1;/, name);
    assert.match(rule, /display: inline-flex;/, name);
    assert.match(rule, /min-height: 28px;/, name);
    assert.match(rule, /border: 1px solid var\(--border\);/, name);
  }
  assert.match(
    css,
    /\.message-stack \.user-row\.stuck > \.message-files \.file-image img \{[^}]*width: 22px;[^}]*height: 22px;/,
  );
  assert.match(
    css,
    /\.message-stack \.user-row\.stuck > \.message-files \.file-image \.file-image-name,\s*\.message-stack \.user-row\.stuck > \.message-files \.file-image \.file-image-size \{\s*display: inline;/,
  );
  const rest = block(/\n\.user-row > \.message-files \.file-image/);
  assert.match(rest, /width: 80px;/, "the resting thumbnail is unchanged");
});

test("the peek only opens for the chip form, floats above everything and leaves on scroll", () => {
  const peek = chat.match(/function peekAttachment\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(peek, /getPropertyValue\("--attachment-compact"\)\.trim\(\) !== "1"\) return;/);
  assert.match(
    peek,
    /closest\("\.split-pane-content"\) \?\? document\.documentElement/,
    "clamps to the pane, not the window",
  );
  assert.match(peek, /document\.addEventListener\("scroll", unpeekAttachment, true\);/);
  assert.match(peek, /peek\.className = "attachment-peek";/);
  const fn = chat.match(/function userAttachmentBadge\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(
    fn,
    /@mouseenter=\$\{peekAttachment\}[\s\S]*?@mouseleave=\$\{unpeekAttachment\}[\s\S]*?@focus=\$\{peekAttachment\}[\s\S]*?@blur=\$\{unpeekAttachment\}/,
  );
  const style = block(/\n\.attachment-peek/);
  assert.match(style, /position: fixed;/);
  assert.match(style, /pointer-events: none;/);
});
