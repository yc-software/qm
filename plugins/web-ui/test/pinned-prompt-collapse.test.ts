import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTranscriptViewport } from "../src/transcript-viewport.ts";

function fixture() {
  const dom = new JSDOM(
    `<section class="chat-scroll"><div class="message-stack"><article class="user-row" data-index="1"><div class="user-bubble"><div class="pin-content">Example prompt</div></div><button class="pin-toggle" hidden>Show more</button></article></div></section>`,
  );
  const scroller = dom.window.document.querySelector<HTMLElement>("section")!;
  const row = scroller.querySelector<HTMLElement>("article")!;
  const bubble = row.querySelector<HTMLElement>(".user-bubble")!;
  const content = row.querySelector<HTMLElement>(".pin-content")!;
  const toggle = row.querySelector<HTMLButtonElement>("button")!;
  let height = 300;
  let fullHeight = 600;
  Object.defineProperties(scroller, { clientHeight: { get: () => height }, scrollHeight: { value: 2000 } });
  Object.defineProperties(bubble, {
    scrollHeight: { get: () => fullHeight },
    clientHeight: {
      get: () =>
        row.classList.contains("pin-expanded")
          ? fullHeight
          : Math.min(fullHeight, parseFloat(row.style.getPropertyValue("--pin-clamp")) || 320),
    },
  });
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: 0, height: bubble.clientHeight + 24 }) as DOMRect;
  const observed = new Set<Element>();
  let resize = () => {};
  const restore = ["ResizeObserver", "getComputedStyle"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(element: Element) {
        observed.add(element);
      }
      unobserve(element: Element) {
        observed.delete(element);
      }
      disconnect() {
        observed.clear();
      }
    },
  });
  const viewport = createTranscriptViewport();
  viewport.sync(scroller);
  return {
    scroller,
    row,
    bubble,
    content,
    toggle,
    observed,
    viewport,
    resize: (next: number) => {
      height = next;
      resize();
    },
    grow: (next: number) => {
      fullHeight = next;
      resize();
    },
    close: () => {
      viewport.dispose();
      dom.window.close();
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("long prompts clamp to the pane and expand or collapse through their button", () => {
  const f = fixture();
  try {
    assert.equal(f.row.style.getPropertyValue("--pin-clamp"), "105px");
    assert.equal(f.toggle.hidden, false);
    f.toggle.click();
    assert.equal(f.row.classList.contains("pin-expanded"), true);
    assert.equal(f.toggle.getAttribute("aria-expanded"), "true");
    assert.equal(f.toggle.textContent, "Show less");
    f.toggle.click();
    assert.ok(f.bubble.scrollHeight > f.bubble.clientHeight);
    assert.equal(f.toggle.getAttribute("aria-expanded"), "false");
  } finally {
    f.close();
  }
});

test("pane resizes respect the minimum and maximum preview heights", () => {
  const f = fixture();
  try {
    f.resize(100);
    assert.equal(f.row.style.getPropertyValue("--pin-clamp"), "96px");
    f.resize(2000);
    assert.equal(f.row.style.getPropertyValue("--pin-clamp"), "320px");
  } finally {
    f.close();
  }
});

test("late content growth reveals the control without a scroll or redraw", () => {
  const f = fixture();
  try {
    assert.ok(f.observed.has(f.content));
    f.grow(40);
    assert.equal(f.toggle.hidden, true);
    f.grow(800);
    assert.equal(f.toggle.hidden, false);
    assert.ok(f.bubble.scrollHeight > f.bubble.clientHeight);
  } finally {
    f.close();
  }
});

test("a reused row resets expansion when its message index changes", () => {
  const f = fixture();
  try {
    f.toggle.click();
    assert.equal(f.row.classList.contains("pin-expanded"), true);
    f.row.dataset.index = "2";
    f.viewport.sync(f.scroller);
    assert.equal(f.row.classList.contains("pin-expanded"), false);
    assert.equal(f.toggle.textContent, "Show more");
  } finally {
    f.close();
  }
});

test("read-only scrollers use the same control and disposal clears presentation", () => {
  const f = fixture();
  try {
    f.scroller.classList.add("readonly-scroll");
    f.toggle.click();
    assert.equal(f.row.classList.contains("pin-expanded"), true);
    f.viewport.dispose();
    assert.equal(f.observed.size, 0);
    assert.equal(f.row.classList.contains("pin-expanded"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-clamp"), "");
    assert.equal(f.toggle.hidden, true);
    f.toggle.click();
    assert.equal(f.row.classList.contains("pin-expanded"), false);
  } finally {
    f.close();
  }
});

test("only the last prompt is measured and expansion survives an unchanged redraw", () => {
  const f = fixture();
  try {
    const earlier = f.row.cloneNode(true) as HTMLElement;
    earlier.className = "user-row";
    earlier.removeAttribute("style");
    earlier.dataset.index = "0";
    const earlierToggle = earlier.querySelector<HTMLButtonElement>(".pin-toggle")!;
    earlierToggle.hidden = true;
    f.row.before(earlier);
    f.viewport.sync(f.scroller);
    assert.equal(earlierToggle.hidden, true);
    assert.equal(earlier.style.getPropertyValue("--pin-clamp"), "");
    f.toggle.click();
    f.viewport.sync(f.scroller);
    assert.equal(f.row.classList.contains("pin-expanded"), true);
    assert.equal(f.toggle.hidden, false);
    assert.equal(f.toggle.textContent, "Show less");
  } finally {
    f.close();
  }
});

test("switching to a new scroller resets expansion even when the message index is identical", () => {
  const f = fixture();
  try {
    f.toggle.click();
    const next = f.scroller.cloneNode(true) as HTMLElement;
    const row = next.querySelector<HTMLElement>(".user-row")!;
    f.scroller.after(next);
    f.viewport.sync(next);
    assert.equal(row.classList.contains("pin-expanded"), false);
    assert.equal(row.querySelector(".pin-toggle")!.getAttribute("aria-expanded"), "false");
    assert.equal(f.row.classList.contains("pin-expanded"), false);
  } finally {
    f.close();
  }
});
