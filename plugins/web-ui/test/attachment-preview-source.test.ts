import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const preview = readFileSync(new URL("../src/attachment-preview.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("every composer attachment chip renders its preview card and keeps remove and view-paste working", () => {
  const strip = composer.slice(
    composer.indexOf('class="attachment-strip"'),
    composer.indexOf('class="composer-input"'),
  );
  assert.match(strip, /\$\{attachmentPreview\(a\)\}/);
  assert.match(strip, /@keydown=\$\{dismissPreviewOnEscape\}/);
  assert.match(strip, /@pointerleave=\$\{restorePreview\}/);
  assert.match(strip, /@focusout=\$\{restorePreview\}/);
  assert.match(strip, /@click=\$\{\(\) => removeAttachment\(a\.id, agent\)\}/);
  assert.match(strip, /@click=\$\{\(\) => openPasteView\(a\.id, agent\)\}/);
});

test("images preview from a data URL, PDFs from their PNG first page, text from extractedText", () => {
  assert.match(preview, /`data:\$\{a\.mimeType\};base64,\$\{a\.preview \?\? a\.content\}`/);
  assert.match(preview, /`data:image\/png;base64,\$\{a\.preview\}`/);
  assert.match(preview, /a\.extractedText\.slice\(0, PREVIEW_TEXT_CHARS\)/);
  assert.match(preview, /formatBytes\(a\.size\)/);
});

test("the card shows after hover intent, hides on Escape, and drops motion under reduced-motion", () => {
  assert.match(
    css,
    /\.file-chip:hover \.attachment-preview,\s*\.file-chip:focus-within \.attachment-preview \{[^}]*transition-delay: 0\.25s;/,
  );
  assert.match(css, /\.file-chip\.preview-dismissed \.attachment-preview \{[^}]*pointer-events: none;/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.attachment-preview \{[^}]*transition-duration: 0s;/,
  );
});
