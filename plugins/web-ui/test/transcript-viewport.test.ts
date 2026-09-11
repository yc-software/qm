import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("only an actually stuck prompt gets elevation", () => {
  const normal =
    css.match(/\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) > \.user-bubble \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(normal, /box-shadow: var/);
  assert.match(css, /\.user-row\.stuck > \.user-bubble/);
});

test("prompt offset reserves the pane's measured pins height", () => {
  assert.match(css, /top: var\(--chat-sticky-top, 0px\)/);
  assert.match(css, /max-height: min\(38cqh, 240px\)/);
});

test("stream following never uses smooth scrolling or a near-bottom zone", () => {
  const scroller = css.match(/\.chat-scroll \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(scroller, /scroll-behavior: smooth/);
  assert.doesNotMatch(chat, /<= 120/);
});

import { JSDOM } from "jsdom";
import { createTranscriptViewport } from "../src/transcript-viewport.ts";

function fixture() {
  const dom = new JSDOM(
    '<section><div class="pinned-strip"></div><div class="message-stack"><article class="user-row"></article></div></section>',
  );
  const s = dom.window.document.querySelector("section")!;
  const pins = s.querySelector<HTMLElement>(".pinned-strip")!;
  const prompt = s.querySelector<HTMLElement>(".user-row")!;
  let height = 1000;
  let pinsHeight = 30;
  let promptTop = 50;
  Object.defineProperties(s, { scrollHeight: { get: () => height }, clientHeight: { value: 200 } });
  s.scrollTop = 800;
  s.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  pins.getBoundingClientRect = () => ({ height: pinsHeight }) as DOMRect;
  prompt.getBoundingClientRect = () => ({ top: promptTop, height: 50 }) as DOMRect;
  const writes: number[] = [];
  let top = s.scrollTop;
  Object.defineProperty(s, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      writes.push(value);
      top = Math.min(value, height - 200);
    },
  });
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let resize = () => {};
  const restore = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "getComputedStyle"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      frames.set(++id, cb);
      return id;
    },
    cancelAnimationFrame: (n: number) => frames.delete(n),
    ResizeObserver: class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const viewport = createTranscriptViewport();
  viewport.sync(s);
  viewport.follow(true);
  for (const cb of frames.values()) cb(0);
  frames.clear();
  writes.length = 0;
  return {
    s,
    prompt,
    viewport,
    writes,
    resize: (pinHeight: number, top: number) => {
      pinsHeight = pinHeight;
      promptTop = top;
      resize();
    },
    grow: () => {
      height += 100;
    },
    scroll: (top: number) => {
      s.scrollTop = top;
      s.dispatchEvent(new dom.window.Event("scroll"));
    },
    wheelUp: () => s.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -1 })),
    flush: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(0);
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

test("a bottom-pinned stream follows growth instantly and coalesces frames", () => {
  const f = fixture();
  try {
    f.grow();
    f.viewport.follow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
    assert.deepEqual(f.writes, [1100]);
  } finally {
    f.close();
  }
});

test("resizing a settled transcript updates the prompt expansion control", () => {
  const f = fixture();
  try {
    f.prompt.innerHTML =
      '<div class="user-bubble"><div class="pin-content"><markdown-block></markdown-block></div></div><button class="pin-toggle" hidden>Show more</button>';
    const bubble = f.prompt.querySelector<HTMLElement>(".user-bubble")!;
    const toggle = f.prompt.querySelector<HTMLButtonElement>(".pin-toggle")!;
    let availableHeight = 240;
    Object.defineProperties(bubble, {
      scrollHeight: { value: 240 },
      clientHeight: { get: () => availableHeight },
    });
    f.viewport.sync(f.s);
    f.resize(30, 50);
    assert.equal(toggle.hidden, true);
    availableHeight = 160;
    f.resize(30, 50);
    assert.equal(toggle.hidden, false);
    availableHeight = 240;
    f.resize(30, 50);
    assert.equal(toggle.hidden, true);
  } finally {
    f.close();
  }
});

test("even a small upward scroll stops following; returning to the bottom resumes it", () => {
  const f = fixture();
  try {
    f.scroll(798);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 798);
    assert.deepEqual(f.writes, [798]);
    f.scroll(900);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 1000);
  } finally {
    f.close();
  }
});

test("an upward wheel cancels a queued follow before its scroll event arrives", () => {
  const f = fixture();
  try {
    f.grow();
    f.viewport.follow();
    f.wheelUp();
    f.flush();
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test("scrolling between scheduling and painting cannot be overwritten", () => {
  const f = fixture();
  try {
    f.grow();
    f.viewport.follow();
    f.s.scrollTop -= 10;
    f.flush();
    assert.deepEqual(f.writes, [790]);
  } finally {
    f.close();
  }
});

test("only reaching the sticky edge elevates the prompt; pin resizes update the edge", () => {
  const f = fixture();
  try {
    f.resize(30, 200);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    f.resize(30, 50);
    assert.equal(f.prompt.classList.contains("stuck"), true);
    f.resize(90, 110);
    assert.equal(f.s.style.getPropertyValue("--chat-sticky-top"), "90px");
    assert.equal(f.prompt.classList.contains("stuck"), true);
    f.scroll(0);
    assert.equal(f.prompt.classList.contains("stuck"), false);
  } finally {
    f.close();
  }
});

test("disposing cancels queued work and clears sticky presentation", () => {
  const f = fixture();
  try {
    f.viewport.follow();
    f.viewport.dispose();
    f.flush();
    assert.equal(f.writes.length, 0);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    assert.equal(f.s.style.getPropertyValue("--chat-sticky-top"), "");
  } finally {
    f.close();
  }
});

test("native scroll anchoring is restored when the reader leaves the bottom", () => {
  const f = fixture();
  try {
    assert.equal(f.s.style.overflowAnchor, "none");
    f.scroll(700);
    assert.equal(f.s.style.overflowAnchor, "");
    f.scroll(800);
    assert.equal(f.s.style.overflowAnchor, "none");
  } finally {
    f.close();
  }
});

test("replacing a scroller does not arm follow without an explicit fresh-session jump", () => {
  const f = fixture();
  try {
    f.viewport.dispose();
    f.viewport.sync(f.s);
    f.viewport.follow();
    f.flush();
    assert.equal(f.writes.length, 0);
    f.viewport.follow(true);
    f.flush();
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

test("redrawing unchanged nodes while reading performs no layout reads", () => {
  const f = fixture();
  try {
    f.scroll(600);
    f.s.getBoundingClientRect = () => {
      throw new Error("unexpected layout read");
    };
    f.viewport.sync(f.s);
    f.viewport.follow();
    f.flush();
    assert.deepEqual(f.writes, [600]);
  } finally {
    f.close();
  }
});

test("a prompt stays in flow when pins leave too little room, and can stick again after resizing", () => {
  const f = fixture();
  try {
    f.resize(160, 180);
    assert.equal(f.prompt.classList.contains("sticky-disabled"), true);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    f.resize(30, 50);
    assert.equal(f.prompt.classList.contains("sticky-disabled"), false);
    assert.equal(f.prompt.classList.contains("stuck"), true);
  } finally {
    f.close();
  }
});
