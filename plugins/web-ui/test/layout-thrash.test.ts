import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("resizeComposer skips the forced-reflow measure pass when the draft value is unchanged", () => {
  const fn = composer.match(/function resizeComposer\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  const skip = fn.indexOf("if (ta.value === autosizedValue) return;");
  const measure = fn.indexOf('ta.style.height = "auto"');
  assert.ok(skip >= 0, "the value memo must gate the measure pass");
  assert.ok(measure >= 0, "the measure pass must still exist");
  assert.ok(skip < measure, "the skip must come BEFORE the height:auto write that dirties layout");
});

test("a box-size change re-arms the composer measure via ResizeObserver (fires after layout, no thrash)", () => {
  assert.match(composer, /new ResizeObserver\(\(\) => \{\s*autosizedValue = null;[\s\S]{0,80}?resizeComposer\(\);/);
  assert.match(composer, /autosizeObserver\.observe\(ta\)/);
  assert.match(composer, /autosizeObserver\.unobserve\(autosizedTa\)/, "the replaced input must be unobserved");
});

test("scrollTranscript's skip path performs zero layout reads", () => {
  const fn = chat.match(/function scrollTranscript\(force = false\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  const beforeRaf = fn.slice(0, fn.indexOf("requestAnimationFrame"));
  for (const read of ["scrollHeight", "clientHeight", "scrollTop -", "getBoundingClientRect"]) {
    assert.ok(!beforeRaf.includes(read), `no sync layout read before the rAF: found ${read}`);
  }
  assert.match(fn, /if \(!force && !stickToBottom\) return;/);
});

test("bottom-stickiness is tracked by the scroller's own scroll listener, and a fresh mount starts pinned", () => {
  assert.match(chat, /class="chat-scroll" @scroll=\$\{onTranscriptScroll\}/);
  assert.match(chat, /stickToBottom = s\.scrollHeight - s\.scrollTop - s\.clientHeight <= 120;/);
  assert.match(chat, /let stickToBottom = true;/);
});
