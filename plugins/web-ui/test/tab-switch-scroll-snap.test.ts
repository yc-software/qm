import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("re-activating a pane tab force-scrolls the transcript (already-loaded panes snap to bottom)", () => {
  const handler = split.match(/onDidVisibilityChange\(\(e\) => \{[\s\S]*?\}\);/)?.[0] ?? "";
  assert.match(handler, /drawActiveChat\(undefined, \{ forceScroll: true \}\)/);
  assert.match(handler, /if \(!this\.loaded\)/, "only already-loaded panes redraw; first show still loads");
  const density = handler.indexOf("this.syncDensity()");
  const draw = handler.indexOf("drawActiveChat(undefined, { forceScroll: true })");
  assert.ok(
    density >= 0 && density < draw,
    "density resyncs before the forced redraw — a hidden pane measured 0\u00d70 and would render scroller-less glance UI",
  );
});

test("a forced transcript scroll bypasses the smooth scroll-behavior (snaps instantly)", () => {
  const fn = chat.match(/function scrollTranscript\(force = false\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  const setAuto = fn.indexOf('scroller.style.scrollBehavior = "auto"');
  const write = fn.indexOf("scroller.scrollTop = scroller.scrollHeight");
  assert.ok(setAuto >= 0, "forced path must set scroll-behavior:auto");
  assert.ok(write > setAuto, "the snap write must come after behavior is set to auto");
});
