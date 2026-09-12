import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTranscriptViewport } from "../src/transcript-viewport.ts";

function fixture() {
  const dom = new JSDOM(
    `<section class="chat-scroll"><div class="pinned-strip"></div><div class="message-stack"><article class="user-row" data-index="1"><div class="user-bubble"><div class="pin-content">Example prompt</div><button class="pin-toggle" hidden>Show more</button></div></article></div></section>`,
  );
  const scroller = dom.window.document.querySelector<HTMLElement>("section")!;
  const row = scroller.querySelector<HTMLElement>("article")!;
  const content = row.querySelector<HTMLElement>(".pin-content")!;
  const toggle = row.querySelector<HTMLButtonElement>("button")!;
  let height = 300;
  let fullHeight = 600;
  let pinsHeight = 0;
  scroller.querySelector<HTMLElement>(".pinned-strip")!.getBoundingClientRect = () =>
    ({ height: pinsHeight }) as DOMRect;
  Object.defineProperties(scroller, { clientHeight: { get: () => height }, scrollHeight: { value: 2000 } });
  Object.defineProperties(content, {
    scrollHeight: { get: () => fullHeight },
    clientHeight: {
      get: () => {
        if (row.classList.contains("pin-expanded")) {
          const limit = row.style.getPropertyValue("--pin-expanded-max");
          return Math.min(fullHeight, limit ? parseFloat(limit) : fullHeight);
        }
        if (row.classList.contains("pin-fits")) return fullHeight;
        return Math.min(fullHeight, parseFloat(row.style.getPropertyValue("--pin-clamp")) || 320);
      },
    },
  });
  content.getBoundingClientRect = () => ({ height: content.clientHeight }) as DOMRect;
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: 0, height: content.clientHeight + 24 }) as DOMRect;
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
    content,
    toggle,
    observed,
    viewport,
    resize: (next: number) => {
      height = next;
      resize();
    },
    setPins: (next: number) => {
      pinsHeight = next;
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
    assert.ok(f.content.scrollHeight > f.content.clientHeight);
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
    assert.ok(f.content.scrollHeight > f.content.clientHeight);
  } finally {
    f.close();
  }
});

test("a reused row resets expansion when its message index changes", () => {
  const f = fixture();
  try {
    f.toggle.click();
    assert.equal(f.row.classList.contains("pin-expanded"), true);
    f.content.scrollTop = 200;
    f.row.dataset.index = "2";
    f.viewport.sync(f.scroller);
    assert.equal(f.row.classList.contains("pin-expanded"), false);
    assert.equal(f.toggle.textContent, "Show more");
    assert.equal(f.content.scrollTop, 0);
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

test("expanding a scrolled prompt stays sticky with a bounded scrollable body", () => {
  const f = fixture();
  try {
    f.scroller.scrollTop = 500;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.classList.contains("stuck"), true);
    f.toggle.click();
    assert.equal(f.row.classList.contains("sticky-disabled"), false);
    assert.equal(f.row.classList.contains("stuck"), true);
    assert.equal(f.content.clientHeight, 276);
    assert.ok(f.content.scrollHeight > f.content.clientHeight);
    assert.equal(f.scroller.scrollTop, 500);
    f.content.scrollTop = 200;
    f.toggle.click();
    assert.equal(f.content.scrollTop, 0);
    assert.equal(f.row.classList.contains("stuck"), true);
    assert.equal(f.content.clientHeight, 105);
    assert.equal(f.scroller.scrollTop, 500);
  } finally {
    f.close();
  }
});

test("expanded prompts reserve pins and chrome when panes resize or content grows", () => {
  const f = fixture();
  try {
    f.setPins(60);
    f.scroller.style.paddingTop = "8px";
    f.scroller.style.paddingBottom = "20px";
    f.row.style.marginBottom = "12px";
    f.toggle.click();
    assert.equal(f.content.clientHeight, 176);
    assert.equal(f.row.classList.contains("sticky-disabled"), false);
    f.resize(220);
    assert.equal(f.content.clientHeight, 96);
    assert.equal(f.row.classList.contains("sticky-disabled"), false);
    f.setPins(80);
    assert.equal(f.content.clientHeight, 76);
    f.grow(1200);
    assert.equal(f.content.clientHeight, 76);
    f.resize(1600);
    assert.equal(f.content.clientHeight, 1200);
    f.viewport.dispose();
    assert.equal(f.row.style.getPropertyValue("--pin-expanded-max"), "");
  } finally {
    f.close();
  }
});

test("an expanded prompt stays in flow when its chrome alone cannot fit", () => {
  const f = fixture();
  try {
    f.setPins(290);
    f.toggle.click();
    assert.equal(f.row.style.getPropertyValue("--pin-expanded-max"), "0px");
    assert.equal(f.row.classList.contains("sticky-disabled"), true);
    f.setPins(30);
    assert.equal(f.row.classList.contains("sticky-disabled"), false);
  } finally {
    f.close();
  }
});
