import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

class FakeVisualViewport extends EventTarget {
  height = 659;
  offsetTop = 0;
}

const dom = new JSDOM(
  '<div class="chat-scroll"></div><form class="composer-wrap"><textarea class="composer-input"></textarea></form>',
  { url: "https://example.test/" },
);
const vv = new FakeVisualViewport();
let scrollCalls = 0;
const rafQueue: Array<() => void> = [];
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
  requestAnimationFrame: {
    value: (cb: () => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    configurable: true,
  },
});
Object.assign(globalThis, { document: dom.window.document, window: dom.window });

const flushFrames = (n = 1): void => {
  for (let i = 0; i < n; i++) {
    const batch = rafQueue.splice(0);
    for (const cb of batch) cb();
  }
};

const transcript = dom.window.document.querySelector<HTMLElement>(".chat-scroll")!;
Object.defineProperties(transcript, {
  scrollHeight: { value: 900, configurable: true },
  clientHeight: { value: 500, configurable: true },
  scrollTop: { value: 300, writable: true, configurable: true },
});
const composerInput = dom.window.document.querySelector<HTMLElement>(".composer-input")!;

const { trackVisualViewport } = await import("../src/viewport.ts");
trackVisualViewport();

const openKeyboard = (): void => {
  vv.height = 350;
  vv.offsetTop = 309;
  vv.dispatchEvent(new Event("resize"));
};
const closeKeyboard = (): void => {
  vv.height = 659;
  vv.offsetTop = 0;
  vv.dispatchEvent(new Event("resize"));
  flushFrames(80);
};

test("an iOS keyboard offset anchors the app to the visual viewport on every viewport event", () => {
  transcript.scrollTop = 300; // 900 - 300 - 500 = 100 < 160 → near bottom
  openKeyboard();

  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vvh"), "350px");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vv-top"), "309px");
  assert.equal(dom.window.document.documentElement.classList.contains("kbd-open"), true);
  assert.ok(scrollCalls >= 1);
  assert.equal(transcript.scrollTop, 900);

  vv.offsetTop = 221;
  vv.dispatchEvent(new Event("scroll"));
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vv-top"), "221px");

  closeKeyboard();
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vv-top"), "0px");
  assert.equal(dom.window.document.documentElement.classList.contains("kbd-open"), false);
});

test("focusing the composer captures the chat anchor BEFORE Safari's reveal scroll mangles it", () => {
  // The regression: user taps the composer while reading near the bottom; Safari scrolls the
  // chat container (and the window) before the keyboard resize lands. The old code sampled
  // "near bottom" at the kbd-open transition — too late — and left the chat wherever Safari
  // dumped it. The anchor must be captured at focusin.
  transcript.scrollTop = 300; // near bottom at focus time
  composerInput.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
  transcript.scrollTop = 0; // Safari's focus-reveal scroll mangles the container pre-resize
  openKeyboard();
  flushFrames(3);
  assert.equal(transcript.scrollTop, 900, "chat re-pinned to bottom from the focus-time anchor");
  closeKeyboard();
});

test("a reader far from the bottom gets their scroll position back, not a jump", () => {
  transcript.scrollTop = 40; // reading history: 900 - 40 - 500 = 360 ≥ 160 → not near bottom
  composerInput.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
  transcript.scrollTop = 700; // browser mangles it
  openKeyboard();
  flushFrames(3);
  assert.equal(transcript.scrollTop, 40, "reading position restored after keyboard open");
  closeKeyboard();
});

test("the user's own touch ends enforcement", () => {
  transcript.scrollTop = 300;
  composerInput.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
  openKeyboard();
  flushFrames(2);
  assert.equal(transcript.scrollTop, 900);
  dom.window.document.dispatchEvent(new dom.window.Event("touchstart"));
  transcript.scrollTop = 123; // user scrolls somewhere
  flushFrames(5);
  assert.equal(transcript.scrollTop, 123, "no re-pin after the user touches the page");
  closeKeyboard();
});
