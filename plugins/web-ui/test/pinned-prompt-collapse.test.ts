import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createTranscriptViewport } from "../src/transcript-viewport.ts";

function fixture() {
  const dom = new JSDOM(
    `<section class="chat-scroll"><div class="pinned-strip"></div><div class="message-stack"><article class="user-row" data-index="1"><div class="user-bubble"><div class="pin-content" style="line-height: 20px">Example prompt</div><button class="pin-toggle" hidden><span class="pin-toggle-label">Show more</span><svg class="icon"></svg></button></div></article></div></section>`,
  );
  const scroller = dom.window.document.querySelector<HTMLElement>("section")!;
  const stack = scroller.querySelector<HTMLElement>(".message-stack")!;
  const row = scroller.querySelector<HTMLElement>("article")!;
  const content = row.querySelector<HTMLElement>(".pin-content")!;
  const toggle = row.querySelector<HTMLButtonElement>("button")!;
  let height = 300;
  let fullHeight = 600;
  let scrollHeight = 2000;
  let pinsHeight = 0;
  scroller.querySelector<HTMLElement>(".pinned-strip")!.getBoundingClientRect = () =>
    ({ height: pinsHeight }) as DOMRect;
  Object.defineProperties(scroller, { clientHeight: { get: () => height }, scrollHeight: { get: () => scrollHeight } });
  Object.defineProperties(content, {
    scrollHeight: { get: () => fullHeight },
    clientHeight: {
      get: () => {
        if (row.classList.contains("pin-expanded")) {
          const limit = row.style.getPropertyValue("--pin-expanded-max");
          return Math.min(fullHeight, limit ? parseFloat(limit) : fullHeight);
        }
        return Math.min(fullHeight, 139.5);
      },
    },
  });
  content.getBoundingClientRect = () => ({ height: content.clientHeight }) as DOMRect;
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  stack.getBoundingClientRect = () => ({ top: -scroller.scrollTop }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: 0, height: content.clientHeight + 24 }) as DOMRect;
  const observed = new Set<Element>();
  let resize = (_entries: Array<{ target: Element }>) => {};
  const restore = ["ResizeObserver", "getComputedStyle"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class {
      constructor(callback: (entries: Array<{ target: Element }>) => void) {
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
    scroll: (top: number) => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new dom.window.Event("scroll"));
    },
    resize: (next: number) => {
      height = next;
      resize([{ target: scroller }]);
    },
    setScrollHeight: (next: number) => {
      scrollHeight = next;
    },
    wheel: (deltaY: number) => {
      scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY }));
    },
    setPins: (next: number) => {
      pinsHeight = next;
      resize([{ target: scroller.querySelector(".pinned-strip")! }]);
    },
    grow: (next: number) => {
      fullHeight = next;
      resize([{ target: content }]);
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
    assert.equal(f.content.clientHeight, 139.5);
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

test("pane resizes keep the compact preview height", () => {
  const f = fixture();
  try {
    f.resize(100);
    assert.equal(f.content.clientHeight, 139.5);
    f.resize(2000);
    assert.equal(f.content.clientHeight, 139.5);
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
    assert.equal(f.content.clientHeight, 139.5);
    assert.equal(f.scroller.scrollTop, 500);
  } finally {
    f.close();
  }
});

test("a stuck prompt keeps the transcript slot it had at rest", () => {
  const f = fixture();
  try {
    const rest = f.row.style.getPropertyValue("--pin-rest-height");
    assert.equal(rest, "163.5px");
    f.scroll(500);
    assert.equal(f.row.classList.contains("stuck"), true);
    f.row.getBoundingClientRect = () => ({ top: 0, height: 60 }) as DOMRect;
    f.scroll(520);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), rest);
    f.toggle.click();
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), rest);
    f.toggle.click();
    f.scroll(0);
    assert.equal(f.row.classList.contains("stuck"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), rest);
    f.resize(300);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "60px");
    f.viewport.dispose();
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "");
  } finally {
    f.close();
  }
});

test("the prompt condenses in step with the scroll, one pixel of height per pixel scrolled", () => {
  const f = fixture();
  try {
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "");
    f.scroll(49.75);
    assert.equal(f.row.classList.contains("stuck"), true);
    assert.equal(f.row.classList.contains("pin-condensed"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "89.75px");
    f.scroll(99.5);
    assert.equal(f.row.classList.contains("pin-condensed"), true);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "40px");
    f.scroll(900);
    assert.equal(f.row.classList.contains("pin-condensed"), true);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "40px");
    f.scroll(20);
    assert.equal(f.row.classList.contains("pin-condensed"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "119.5px");
    f.scroll(0);
    assert.equal(f.row.classList.contains("stuck"), false);
    assert.equal(f.row.classList.contains("pin-condensed"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "");
    f.scroll(60);
    f.toggle.click();
    assert.equal(f.row.classList.contains("pin-condensed"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "");
  } finally {
    f.close();
  }
});

test("auto-follow layout clamps do not reverse an in-progress prompt collapse", () => {
  const f = fixture();
  try {
    f.setScrollHeight(349.75);
    f.scroll(49.75);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "89.75px");

    f.setScrollHeight(340);
    f.scroll(40);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "89.75px");

    f.wheel(-10);
    f.scroll(30);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "99.75px");
    f.scroll(40);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "89.75px");
  } finally {
    f.close();
  }
});

test("the collapse is measured from the row's resting place, so it survives being opened mid-scroll", () => {
  const f = fixture();
  try {
    f.scroll(30);
    f.row.dataset.index = "7";
    f.viewport.sync(f.scroller);
    assert.equal(f.row.classList.contains("stuck"), true);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "109.5px");
    f.scroll(70);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "69.5px");
  } finally {
    f.close();
  }
});

test("rest heights are re-measured for pane and content changes, condensed or not", () => {
  const f = fixture();
  try {
    f.scroll(500);
    assert.equal(f.row.classList.contains("pin-condensed"), true);
    f.grow(40);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "64px");
    assert.equal(f.row.classList.contains("pin-condensed"), true);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "40px");
    f.grow(800);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "163.5px");
    f.scroll(20);
    assert.equal(f.row.classList.contains("pin-condensed"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "119.5px");
    f.resize(300);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "163.5px");
    f.scroll(0);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "");
  } finally {
    f.close();
  }
});

test("rest heights are never taken from an expanded prompt", () => {
  const f = fixture();
  try {
    f.scroll(500);
    f.toggle.click();
    assert.equal(f.row.classList.contains("pin-expanded"), true);
    f.resize(280);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "163.5px");
    f.toggle.click();
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "163.5px");
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "40px");
    f.scroll(20);
    assert.equal(f.row.style.getPropertyValue("--pin-content-max"), "119.5px");
  } finally {
    f.close();
  }
});

test("the disclosure rides the last visible line while clamped and drops to a row when expanded or over rich content", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const bubble = css.match(/\n\.user-bubble \{[^}]*\}/)?.[0] ?? "";
  assert.match(bubble, /--bubble-bg: color-mix/);
  assert.match(bubble, /position: relative/);
  const toggle = css.match(/\n\.pin-toggle \{[^}]*\}/)?.[0] ?? "";
  assert.match(toggle, /position: absolute/);
  assert.match(toggle, /height: 1lh/);
  assert.match(toggle, /background: linear-gradient\(to right, transparent, var\(--bubble-bg\)/);
  assert.doesNotMatch(toggle, /font-size/);
  const row =
    css.match(
      /\.user-row\.pin-expanded > \.user-bubble > \.pin-toggle,\s*\.message-stack\s+\.user-bubble\s+> \.pin-content:has\(code-block[^{]*~ \.pin-toggle \{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(row, /position: static/);
  assert.match(row, /margin: 6px 0 0 auto/);
  assert.match(
    css,
    /\.user-row\.pin-expanded > \.user-bubble > \.pin-toggle > \.icon \{\s*transform: rotate\(180deg\);/,
  );
});

test("the condensed strip keeps the resting line layout, with a scroll-driven height on stuck", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const stuck =
    css.match(/\.message-stack \.user-row\.stuck:not\(\.pin-expanded\) \.user-bubble > \.pin-content \{[^}]*\}/)?.[0] ??
    "";
  assert.match(stuck, /max-height: var\(--pin-content-max, none\)/);
  assert.doesNotMatch(stuck, /line-clamp|transition/);
  assert.match(css, /\.user-row\.stuck:not\(\.pin-expanded\) \{\s*min-height: var\(--pin-rest-height\)/);
  assert.match(
    css,
    /\.user-row\.stuck:not\(\.pin-expanded\)\s+\.user-bubble\s+> \.pin-content:has\(code-block[^{]*\{\s*max-height: var\(--pin-content-max, 6lh\)/,
  );
  const rest =
    css.match(
      /\.message-stack \.user-row\.latest-prompt:not\(\.pin-expanded\) \.user-bubble > \.pin-content \{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(rest, /-webkit-line-clamp: 6/);
  assert.doesNotMatch(rest, /max-height|transition/);
  assert.doesNotMatch(css, /pin-condensed[^{]*\{[^}]*transition/);
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

test("repeated prompt measurement preserves the disclosure text node", () => {
  const f = fixture();
  try {
    const text = f.toggle.querySelector(".pin-toggle-label")!;
    const label = text.firstChild;
    for (const height of [300, 200, 500]) {
      f.resize(height);
      assert.equal(text.firstChild, label);
    }
    f.toggle.click();
    const expandedLabel = text.firstChild;
    assert.notEqual(expandedLabel, label);
    f.resize(400);
    assert.equal(text.firstChild, expandedLabel);
  } finally {
    f.close();
  }
});

test("ordinary multi-line prompts stay fully visible without a disclosure", () => {
  const f = fixture();
  try {
    for (const height of [70, 100, 139]) {
      f.grow(height);
      assert.equal(f.content.clientHeight, height);
      assert.equal(f.toggle.hidden, true);
    }
    f.grow(250);
    assert.equal(f.toggle.hidden, false);
    f.toggle.click();
    assert.equal(f.content.clientHeight, 250);
  } finally {
    f.close();
  }
});

test("condensing clips content without changing its typography", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const rules = css.match(/[^{}]*\.pin-condensed[^{}]*\{[^}]*\}/g) ?? [];
  for (const rule of rules) assert.doesNotMatch(rule, /margin|font-size|line-height|line-clamp/);
});

test("border-box prompts reserve the entire row including the metadata lane", () => {
  const f = fixture();
  try {
    f.row.style.boxSizing = "border-box";
    f.row.style.paddingTop = "8px";
    f.row.style.paddingBottom = "24px";
    f.resize(400);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "163.5px");
    f.scroll(50);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "163.5px");
  } finally {
    f.close();
  }
});

test("pinned image chips cannot grow into more rows than their thumbnails", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const rule = css.match(/\.user-row\.stuck > \.message-files > \.attachment-images \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /flex-wrap: nowrap/);
  assert.match(rule, /overflow-x: auto/);
  assert.match(rule, /justify-content: safe flex-end/);
});
