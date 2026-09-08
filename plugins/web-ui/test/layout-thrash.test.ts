import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const viewport = readFileSync(new URL("../src/transcript-viewport.ts", import.meta.url), "utf8");
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

test("bottom-follow's skip path performs zero layout reads", () => {
  const fn = viewport.slice(viewport.indexOf("  function follow("));
  const skip = fn.indexOf("if (!scroller || !following || frame !== null) return;");
  const firstRead = fn.indexOf("const priorTop = element.scrollTop;");
  assert.ok(skip >= 0 && skip < firstRead);
  assert.match(viewport, /if \(changed\) syncSticky\(\);/);
});

test("bottom-follow belongs to each scroller, and fresh mounts start pinned", () => {
  assert.match(viewport, /addEventListener\("scroll", onScroll/);
  assert.match(viewport, /const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;/);
  assert.match(viewport, /if \(force\) \{\s*setFollowing\(true\);/);
});

test("revealing a transcript re-arms follow; read-only mounts start at the end except pagination", () => {
  assert.match(chat, /function scrollToBottom\(\): void \{\s*scrollTranscript\(true\);/);
  assert.match(chat, /if \(!sameSession\) scrollToBottom\(\);/);
  assert.match(chat, /transcriptViewport.follow\(force\);/);
});

test("composer measurement holds its outer height instead of temporarily resizing the transcript", () => {
  const fn = composer.slice(composer.indexOf("  function resizeComposer("));
  const lock = fn.indexOf("wrap.style.height = `${wrap.getBoundingClientRect().height}px`");
  const measure = fn.indexOf('ta.style.height = "auto"');
  const release = fn.indexOf("wrap.style.height = wrapHeight");
  assert.ok(lock >= 0 && lock < measure && release > measure);
});

test("both pagination paths adjust their anchor without smooth scrolling", () => {
  const anchors = chat.match(
    /const prev = scrollerNow\.style\.scrollBehavior;\s*scrollerNow\.style\.scrollBehavior = "auto";\s*scrollerNow\.scrollTop = priorTop \+ \(scrollerNow\.scrollHeight - priorHeight\);\s*scrollerNow\.style\.scrollBehavior = prev;/g,
  );
  assert.equal(anchors?.length, 2);
});
