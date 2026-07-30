import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("composer input rests overflow-hidden below the height cap", () => {
  const block = css.match(/\.composer-input \{[^}]*\}/)?.[0] ?? "";
  assert.match(block, /overflow-y: hidden;/, "base CSS must suppress the scrollbar below the cap");
});

test("resizeComposer opens scrolling only past the cap and pins scrollTop under it", () => {
  const fn = composer.match(/function resizeComposer\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(
    fn,
    /const cap = parseFloat\(getComputedStyle\(ta\)\.maxHeight\) \|\| 180;/,
    "the cap follows the computed max-height (120 pane / 180 main)",
  );
  assert.match(fn, /content > cap/, "overflow flips on content beyond the cap only");
  assert.match(fn, /overflowY = "auto"/);
  assert.match(fn, /overflowY = "hidden"/);
  assert.match(fn, /ta\.scrollTop = 0/, "under the cap any residual scroll offset is cleared");
});

test("the send-clear path resets overflow and scroll before the input is seen empty", () => {
  const fn = composer.match(/function clearComposerDom\(agent: Agent\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(fn, /overflowY = "hidden"/, "clearing must close the scroller synchronously");
  assert.match(fn, /scrollTop = 0/, "clearing must drop the clamped scroll offset");
});
