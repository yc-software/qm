import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

class FakeVisualViewport extends EventTarget {
  height = 659;
  offsetTop = 0;
  scale = 1;
}

const dom = new JSDOM('<div class="chat-scroll"></div>', { url: "https://example.test/" });
const vv = new FakeVisualViewport();
let scrollCalls = 0;
Object.defineProperties(dom.window, {
  innerHeight: { value: 659, configurable: true },
  scrollY: { value: 309, configurable: true },
  visualViewport: { value: vv, configurable: true },
  matchMedia: {
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  },
  scrollTo: { value: () => scrollCalls++, configurable: true },
});
Object.assign(globalThis, { document: dom.window.document, window: dom.window });

const transcript = dom.window.document.querySelector<HTMLElement>(".chat-scroll")!;
Object.defineProperties(transcript, {
  scrollHeight: { value: 900 },
  clientHeight: { value: 500 },
  scrollTop: { value: 300, writable: true },
});

const { trackVisualViewport } = await import("../src/viewport.ts");
trackVisualViewport();
const style = dom.window.document.documentElement.style;

function viewport(height: number, offsetTop = 0, scale = 1, event = "resize") {
  Object.assign(vv, { height, offsetTop, scale });
  vv.dispatchEvent(new Event(event));
}

test("keyboard resize and pan follow the visual viewport without fighting document scroll", () => {
  viewport(350, 309);
  assert.equal(style.getPropertyValue("--vvh"), "350px");
  assert.equal(style.getPropertyValue("--vv-top"), "309px");
  assert.equal(scrollCalls, 0);
  assert.equal(transcript.scrollTop, 300);

  viewport(350, 221, 1, "scroll");
  assert.equal(style.getPropertyValue("--vv-top"), "221px");
  assert.equal(scrollCalls, 0);

  viewport(659);
  assert.equal(style.getPropertyValue("--vvh"), "659px");
  assert.equal(style.getPropertyValue("--vv-top"), "0px");
});

test("small viewport changes track their origin without a keyboard-height threshold", () => {
  viewport(600, 40);
  assert.equal(style.getPropertyValue("--vvh"), "600px");
  assert.equal(style.getPropertyValue("--vv-top"), "40px");
});

test("pinch zoom does not resize or reposition the app shell", () => {
  viewport(659);
  viewport(329.5, 100, 2);
  viewport(329.5, 160, 2, "scroll");
  assert.equal(style.getPropertyValue("--vvh"), "659px");
  assert.equal(style.getPropertyValue("--vv-top"), "0px");
  viewport(350, 80);
  assert.equal(style.getPropertyValue("--vvh"), "350px");
  assert.equal(style.getPropertyValue("--vv-top"), "80px");
});

test("window resize refreshes geometry after orientation changes", () => {
  Object.assign(vv, { height: 280, offsetTop: 10, scale: 1 });
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  assert.equal(style.getPropertyValue("--vvh"), "280px");
  assert.equal(style.getPropertyValue("--vv-top"), "10px");
});

test("browsers without VisualViewport use the CSS fallback", () => {
  Object.defineProperty(dom.window, "visualViewport", { value: undefined, configurable: true });
  assert.doesNotThrow(trackVisualViewport);
  Object.defineProperty(dom.window, "visualViewport", { value: vv, configurable: true });
});

test("the phone shell is anchored to the layout viewport rather than document flow", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const layout = [...css.matchAll(/\.layout \{([^}]+)\}/g)].find((match) => match[1]!.includes("--vvh"))![1]!;
  assert.match(css, /@media \(max-width: 860px\), \(hover: none\) and \(pointer: coarse\)/);
  assert.match(layout, /position: fixed;/);
  assert.match(layout, /inset: 0 0 auto;/);
  assert.match(layout, /height: var\(--vvh, 100dvh\);/);
  assert.match(layout, /transform: translateY\(var\(--vv-top, 0px\)\);/);
});

test("keyboard sizing includes bannered shells and touch inputs avoid focus zoom", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.layout\.bannered,\s*\.layout\.impersonating \{\s*height: calc\(var\(--vvh, 100dvh\) - 38px - env\(safe-area-inset-top\)\);/,
  );
  assert.match(css, /\.top-banner,\s*\.impersonation-banner \{\s*transform: translateY\(var\(--vv-top, 0px\)\);/);
  assert.match(
    css,
    /\.composer-input,\s*\.live-work-line \{\s*font-size: max\(16px, var\(--composer-font-size, 16px\)\);/,
  );
});
