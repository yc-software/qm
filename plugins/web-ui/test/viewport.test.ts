import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

class FakeVisualViewport extends EventTarget {
  height = 659;
  offsetTop = 0;
}

const dom = new JSDOM('<div class="chat-scroll"></div>', { url: "https://example.test/" });
const vv = new FakeVisualViewport();
let scrollCalls = 0;
Object.defineProperties(dom.window, {
  innerHeight: { value: 659, configurable: true },
  scrollY: { get: () => (vv.offsetTop ? 309 : 0), configurable: true },
  visualViewport: { value: vv, configurable: true },
  matchMedia: {
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  },
  scrollTo: {
    value: () => {
      scrollCalls++;
    },
    configurable: true,
  },
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

test("an iOS keyboard offset anchors the app to the visual viewport on every viewport event", () => {
  vv.height = 350;
  vv.offsetTop = 309;
  vv.dispatchEvent(new Event("resize"));

  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vvh"), "350px");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vv-top"), "309px");
  assert.equal(dom.window.document.documentElement.classList.contains("kbd-open"), true);
  assert.equal(scrollCalls, 1);
  assert.equal(transcript.scrollTop, 900);

  vv.offsetTop = 221;
  vv.dispatchEvent(new Event("scroll"));
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vv-top"), "221px");
  assert.equal(scrollCalls, 2);

  vv.height = 659;
  vv.offsetTop = 0;
  vv.dispatchEvent(new Event("resize"));
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vv-top"), "0px");
  assert.equal(dom.window.document.documentElement.classList.contains("kbd-open"), false);
});
