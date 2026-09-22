import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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
        return Math.min(fullHeight, 139.5);
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

test("a stuck prompt condenses but keeps the transcript slot it had at rest", () => {
  const f = fixture();
  try {
    const rest = f.row.style.getPropertyValue("--pin-rest-height");
    assert.equal(rest, "163.5px");
    f.scroller.scrollTop = 500;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.classList.contains("stuck"), true);
    f.row.getBoundingClientRect = () => ({ top: 0, height: 60 }) as DOMRect;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), rest);
    f.toggle.click();
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), rest);
    f.toggle.click();
    f.scroller.scrollTop = 0;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.classList.contains("stuck"), false);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), rest);
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), rest);
    f.resize(300);
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "60px");
    f.viewport.dispose();
    assert.equal(f.row.style.getPropertyValue("--pin-rest-height"), "");
  } finally {
    f.close();
  }
});

test("the rest height of the prompt body is re-measured on resize, never while the strip is settling", () => {
  const f = fixture();
  try {
    assert.equal(f.row.style.getPropertyValue("--pin-content-rest"), "139.5px");
    let animations = 0;
    (f.content as HTMLElement & { getAnimations: () => Animation[] }).getAnimations = () =>
      Array.from({ length: animations }, () => null) as unknown as Animation[];
    f.scroller.scrollTop = 500;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    f.content.getBoundingClientRect = () => ({ height: 46 }) as DOMRect;
    f.scroller.scrollTop = 0;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.style.getPropertyValue("--pin-content-rest"), "139.5px");
    animations = 1;
    f.resize(280);
    assert.equal(f.row.style.getPropertyValue("--pin-content-rest"), "139.5px");
    animations = 0;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.style.getPropertyValue("--pin-content-rest"), "46px");
    f.viewport.dispose();
    assert.equal(f.row.style.getPropertyValue("--pin-content-rest"), "");
  } finally {
    f.close();
  }
});

test("sticking and releasing tween the prompt body between its two heights once motion is armed", () => {
  const f = fixture();
  const now = performance.now;
  try {
    const calls: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    let cancelled = 0;
    (f.content as HTMLElement & { animate: unknown }).animate = (
      frames: Keyframe[],
      options: KeyframeAnimationOptions,
    ) => {
      calls.push({ frames, options });
      return { cancel: () => cancelled++ } as unknown as Animation;
    };
    f.row.style.setProperty("--pin-motion", "180ms");
    const clock = 5000;
    performance.now = () => clock;
    f.scroller.scrollTop = 500;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.classList.contains("stuck"), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].frames, [{ maxHeight: "139.5px" }, { maxHeight: "2lh" }]);
    assert.equal(calls[0].options.duration, 180);
    f.content.getBoundingClientRect = () => ({ height: 80 }) as DOMRect;
    f.scroller.scrollTop = 0;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(calls.length, 2);
    assert.equal(cancelled, 1);
    assert.deepEqual(calls[1].frames, [{ maxHeight: "80px" }, { maxHeight: "139.5px" }]);
    f.row.style.setProperty("--pin-motion", "0s");
    f.scroller.scrollTop = 500;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(calls.length, 2);
    assert.equal(cancelled, 2);
    f.viewport.dispose();
    assert.equal(cancelled, 2);
  } finally {
    performance.now = now;
    f.close();
  }
});

test("motion is armed only once a prompt has been on screen for a moment", () => {
  const f = fixture();
  const now = performance.now;
  try {
    let clock = 1000;
    performance.now = () => clock;
    f.row.dataset.index = "9";
    f.viewport.sync(f.scroller);
    assert.equal(f.row.classList.contains("pin-motion"), false);
    clock = 1200;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.classList.contains("pin-motion"), false);
    clock = 1300;
    f.scroller.dispatchEvent(new f.scroller.ownerDocument.defaultView!.Event("scroll"));
    assert.equal(f.row.classList.contains("pin-motion"), true);
    f.row.dataset.index = "10";
    f.viewport.sync(f.scroller);
    assert.equal(f.row.classList.contains("pin-motion"), false);
  } finally {
    performance.now = now;
    f.close();
  }
});

test("the condensed strip is a css contract on the stuck class, never on rest", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const condensed =
    css.match(/\.message-stack \.user-row\.stuck:not\(\.pin-expanded\) \.user-bubble > \.pin-content \{[^}]*\}/)?.[0] ??
    "";
  assert.match(condensed, /-webkit-line-clamp: 2/);
  assert.doesNotMatch(condensed, /max-height/);
  assert.match(css, /\.user-row:not\(:has\(~ \.user-row\)\) \{[^}]*min-height: var\(--pin-rest-height\)/);
  assert.doesNotMatch(css, /\.user-row\.stuck:not\(\.pin-expanded\) \{\s*min-height/);
  const rest =
    css.match(
      /\.message-stack \.user-row:not\(:has\(~ \.user-row\)\):not\(\.pin-expanded\) \.user-bubble > \.pin-content \{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(rest, /-webkit-line-clamp: 6/);
  assert.doesNotMatch(rest, /max-height/);
});

test("the strip eases between its heights only when motion is armed, and not under reduced motion", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const motion = css.match(/\.message-stack \.user-row\.pin-motion \.user-bubble > \.pin-content \{[^}]*\}/)?.[0] ?? "";
  assert.match(motion, /transition: -webkit-line-clamp 0s var\(--pin-clamp-delay\) allow-discrete/);
  assert.doesNotMatch(motion, /max-height/);
  assert.match(
    css,
    /\.user-row\.pin-motion:where\(\.stuck:not\(\.pin-expanded\)\) \{\s*--pin-motion: 180ms;\s*--pin-clamp-delay: 180ms/,
  );
  assert.match(
    css,
    /prefers-reduced-motion: reduce\) \{\s*\.message-stack \.user-row\.pin-motion \{\s*--pin-motion: 0s/,
  );
  const plain = css.replace(/\.pin-motion[^{]*\{[^}]*\}/g, "");
  assert.doesNotMatch(plain.match(/\.pin-content \{[^}]*\}/g)?.join("") ?? "", /transition/);
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
    const label = f.toggle.firstChild;
    for (const height of [300, 200, 500]) {
      f.resize(height);
      assert.equal(f.toggle.firstChild, label);
    }
    f.toggle.click();
    const expandedLabel = f.toggle.firstChild;
    assert.notEqual(expandedLabel, label);
    f.resize(400);
    assert.equal(f.toggle.firstChild, expandedLabel);
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
