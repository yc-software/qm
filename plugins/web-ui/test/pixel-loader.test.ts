import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { elapsedLabel } from "../src/work-duration.ts";

test("elapsedLabel shows tenths under a minute and zero-padded seconds after", () => {
  assert.equal(elapsedLabel(0), "0.0s");
  assert.equal(elapsedLabel(-500), "0.0s");
  assert.equal(elapsedLabel(8_240), "8.2s");
  assert.equal(elapsedLabel(59_960), "59.9s");
  assert.equal(elapsedLabel(60_000), "1m 00s");
  assert.equal(elapsedLabel(64_400), "1m 04s");
  assert.equal(elapsedLabel(3_725_000), "62m 05s");
});

test("pixelLoader renders a nine-cell grid that announces only when labelled", async () => {
  const dom = new JSDOM("<main></main>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { render } = await import("lit");
  const { pixelLoader } = await import("../src/ui.ts");
  const host = dom.window.document.querySelector("main")!;

  render(pixelLoader("Loading"), host);
  const labelled = host.querySelector(".pixel-loader")!;
  assert.equal(labelled.querySelectorAll("i").length, 9);
  assert.equal(labelled.getAttribute("role"), "status");
  assert.equal(labelled.getAttribute("aria-label"), "Loading");
  assert.equal(labelled.hasAttribute("aria-hidden"), false);
  assert.deepEqual(
    [...labelled.querySelectorAll("i")].map((cell) => cell.getAttribute("style")),
    [90, 180, 270, 0, 90, 180, 90, 180, 270].map((ms) => `animation-delay:${ms}ms`),
  );

  render(pixelLoader(), host);
  const decorative = host.querySelector(".pixel-loader")!;
  assert.equal(decorative.getAttribute("aria-hidden"), "true");
  assert.equal(decorative.hasAttribute("role"), false);
  assert.equal(decorative.hasAttribute("aria-label"), false);
});
