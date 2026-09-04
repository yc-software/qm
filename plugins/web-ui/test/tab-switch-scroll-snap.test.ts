import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("shown panes start at the end after refreshing their density", () => {
  const handler = split.match(/onDidVisibilityChange\(\(e\) => \{[\s\S]*?\}\);/)?.[0] ?? "";
  assert.match(handler, /this\.conversation\.scrollToBottom\(\)/);
  assert.match(handler, /this\.syncDensity\(\)/, "shown panes still refresh their responsive presentation");
});

test("hidden tabs do not require attached transcript DOM", () => {
  assert.doesNotMatch(split, /defaultRenderer: "always"/);
  assert.doesNotMatch(split, /restoreTranscriptViewport/);
  assert.doesNotMatch(chat, /transcriptTop/);
});

test("showing a pane that is already its tile's active tab does not re-open it", () => {
  const fn = split.match(/function activatePanel\(panel: IDockviewPanel\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /panel\.group\.activePanel === panel\) panel\.group\.api\.setActive\(\)/);
  const focus = split.match(/function focusPane\(paneId: string\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(focus, /activatePanel\(panel\)/);
  assert.doesNotMatch(focus, /panel\.api\.setActive\(\)/);
});

test("responsive pane summaries do not replace the transcript scroller", () => {
  assert.match(chat, /glanceTier\s*\?\s*paneGlance\([^)]+\)\s*:\s*nothing[\s\S]*?<section class="chat-scroll"/);
  assert.doesNotMatch(
    chat,
    /glanceTier\s*\?\s*paneGlance\([^)]+\)\s*:\s*html`<section class="chat-scroll"/,
    "presentation changes must not destroy the element that owns scrollTop",
  );
});

test("hidden panes retain their last meaningful density, and every measure writes the attribute", () => {
  const fn = split.match(/private syncDensity\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(fn, /if \(!next\) return;/, "an unmeasurable pane keeps its last density");
  assert.doesNotMatch(
    fn,
    /next === this\.density\) return;/,
    "the DOM write must not be skipped when the measured tier equals the starting one",
  );
  const write = fn.indexOf("this.element.dataset.density");
  const gate = fn.indexOf("if (!changed) return;");
  assert.ok(write >= 0, "the tier is published to the DOM");
  assert.ok(
    gate > write,
    "only the redraw callbacks are gated on an actual change — a pane that mounts at its starting tier still gets the attribute",
  );
});

test("pane composer sizing hangs off the density attribute, so writing it is load-bearing", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const block = css.match(/\[data-density\] \.composer-input \{[^}]*\}/)?.[0] ?? "";
  assert.match(
    block,
    /min-height: 0;/,
    "without the attribute the pane composer falls back to the main-window min-height",
  );
});
