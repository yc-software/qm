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
import { createTranscriptViewport, preserveTranscriptScroll } from "../src/transcript-viewport.ts";

test("layout mutations preserve bottom following and an earlier reading anchor independently", () => {
  const dom = new JSDOM(
    '<main><section class="chat-scroll"><div class="message-stack"><p>Reading here</p></div></section><section class="chat-scroll"></section></main>',
  );
  const root = dom.window.document.querySelector("main")!;
  const [reading, following] = [...root.querySelectorAll<HTMLElement>("section")];
  const anchor = reading!.querySelector("p")!;
  let height = 1000;
  let anchorTop = 330;
  for (const element of [reading!, following!]) {
    Object.defineProperties(element, { clientHeight: { value: 200 }, scrollHeight: { get: () => height } });
    element.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  }
  anchor.getBoundingClientRect = () =>
    ({ top: 20 + anchorTop - reading!.scrollTop, bottom: 100 + anchorTop - reading!.scrollTop }) as DOMRect;
  reading!.scrollTop = 350;
  following!.scrollTop = 800;
  const restore = preserveTranscriptScroll(root);
  reading!.scrollTop = following!.scrollTop = 0;
  anchorTop += 120;
  height += 300;
  restore();
  assert.equal(reading!.scrollTop, 470);
  assert.equal(following!.scrollTop, 1300);
  assert.equal(anchor.getBoundingClientRect().top, 0);
});

test("layout restoration ignores removed panes and falls back when an anchor was replaced", () => {
  const dom = new JSDOM(
    '<main><section class="chat-scroll"><div class="message-stack"><p>Reading</p></div></section><section class="chat-scroll"></section></main>',
  );
  const root = dom.window.document.querySelector("main")!;
  const [reading, removed] = [...root.querySelectorAll<HTMLElement>("section")];
  for (const element of [reading!, removed!]) {
    Object.defineProperties(element, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    element.scrollTop = 350;
  }
  reading!.querySelector("p")!.getBoundingClientRect = () => ({ top: 10, bottom: 50 }) as DOMRect;
  const restore = preserveTranscriptScroll(root);
  reading!.replaceChildren();
  removed!.remove();
  reading!.scrollTop = removed!.scrollTop = 0;
  restore();
  assert.equal(reading!.scrollTop, 350);
  assert.equal(removed!.scrollTop, 0);
});

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
    fit: () => {
      height = 200;
      s.scrollTop = 0;
      s.dispatchEvent(new dom.window.Event("scroll"));
      writes.length = 0;
    },
    collapse: () => {
      height = 400;
      s.scrollTop = Math.min(s.scrollTop, 200);
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

test("scrolling toward earlier messages loads before reaching the top and pauses following", () => {
  const f = fixture();
  try {
    const button = f.s.ownerDocument.createElement("button");
    button.className = "earlier-messages-btn";
    f.s.querySelector(".message-stack")!.prepend(button);
    let loads = 0;
    button.onclick = () => {
      loads++;
      button.disabled = true;
    };
    f.viewport.sync(f.s);
    assert.equal(loads, 0);
    f.scroll(500);
    assert.equal(loads, 0);
    f.scroll(350);
    assert.equal(loads, 1);
    f.scroll(100);
    f.wheelUp();
    assert.equal(loads, 1);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 100);
    button.disabled = false;
    f.scroll(300);
    assert.equal(loads, 1);
    f.scroll(200);
    assert.equal(loads, 2);
  } finally {
    f.close();
  }
});

test("upward wheel loads history even when the transcript cannot scroll", () => {
  const f = fixture();
  try {
    f.fit();
    const button = f.s.ownerDocument.createElement("button");
    button.className = "earlier-messages-btn";
    f.s.querySelector(".message-stack")!.prepend(button);
    let loads = 0;
    button.onclick = () => {
      loads++;
    };
    f.wheelUp();
    assert.equal(loads, 1);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 0);
    f.viewport.dispose();
    f.wheelUp();
    assert.equal(loads, 1);
  } finally {
    f.close();
  }
});

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
      '<div class="user-bubble"><div class="pin-content"><markdown-block></markdown-block></div><button class="pin-toggle" hidden>Show more</button></div>';
    const content = f.prompt.querySelector<HTMLElement>(".pin-content")!;
    const toggle = f.prompt.querySelector<HTMLButtonElement>(".pin-toggle")!;
    let availableHeight = 240;
    Object.defineProperties(content, {
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

test("an upward wheel that cannot move a short transcript keeps following its growth", () => {
  const f = fixture();
  try {
    f.fit();
    f.wheelUp();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 100);
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

test("prompt expansion control belongs inside the bubble in both renderers", () => {
  for (const [source, start] of [
    [chat, '<article class="message-row user-row'],
    [readFileSync(new URL("../src/shared-session.ts", import.meta.url), "utf8"), "<article class=${"],
  ]) {
    const rowStart = source!.indexOf(start!);
    assert.ok(rowStart >= 0);
    const row = source!.slice(rowStart, source!.indexOf("</article>", rowStart) + "</article>".length);
    const dom = new JSDOM(row);
    try {
      const toggle = dom.window.document.querySelector(".pin-toggle");
      assert.equal(toggle?.parentElement?.tagName, "DIV");
      assert.equal(toggle?.parentElement?.parentElement?.tagName, "ARTICLE");
    } finally {
      dom.window.close();
    }
  }
  assert.match(css, /:not\(\.pin-expanded\)\s+\.user-bubble\s+>\s+\.pin-content \{/);
  assert.match(css, /\.user-bubble > \.pin-toggle:not\(\[hidden\]\)/);
});

test("nested paste and attachment controls do not toggle the whole prompt", () => {
  const f = fixture();
  try {
    f.prompt.innerHTML =
      '<div class="user-bubble"><div class="pin-content"><code-block><button class="text-code-toggle">Show more</button><copy-button><button>Copy</button></copy-button></code-block><div class="message-files"><a class="file-chip" href="#file">notes.txt</a></div></div><button class="pin-toggle" hidden>Show more</button></div>';
    const content = f.prompt.querySelector<HTMLElement>(".pin-content")!;
    const toggle = f.prompt.querySelector<HTMLButtonElement>(".pin-toggle")!;
    Object.defineProperties(content, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 160 },
    });
    f.viewport.sync(f.s);
    assert.equal(toggle.hidden, false);
    for (const expanded of [false, true]) {
      if (expanded) toggle.click();
      for (const selector of [".text-code-toggle", "copy-button button", ".file-chip"]) {
        f.prompt.querySelector<HTMLElement>(selector)!.click();
        assert.equal(f.prompt.classList.contains("pin-expanded"), expanded);
        assert.equal(toggle.getAttribute("aria-expanded"), String(expanded));
      }
    }
  } finally {
    f.close();
  }
});

test("plain-text copy confirmation can grow beyond its icon width", () => {
  const rule = css.match(/\.user-bubble code-block\[language="text"\] copy-button button \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /min-width: var\(--meta-lane\)/);
  assert.doesNotMatch(rule, /(?:^|[;{])\s*width:/);
});

test("prompt clipping tolerates rounding but discloses any additional text line", () => {
  const f = fixture();
  try {
    f.prompt.innerHTML =
      '<div class="user-bubble"><div class="pin-content"></div><button class="pin-toggle" hidden>Show more</button></div>';
    const content = f.prompt.querySelector<HTMLElement>(".pin-content")!;
    const toggle = f.prompt.querySelector<HTMLButtonElement>(".pin-toggle")!;
    let overflow = 5;
    Object.defineProperties(content, {
      scrollHeight: { get: () => 160 + overflow },
      clientHeight: { value: 160 },
    });
    f.viewport.sync(f.s);
    for (overflow of [0, 1, 2, 23, 100, 1]) {
      f.resize(30, 50);
      assert.equal(toggle.hidden, overflow <= 1);
      f.resize(30, 50);
      assert.equal(toggle.hidden, overflow <= 1, "stable on repeated measurements");
    }
    f.viewport.dispose();
  } finally {
    f.close();
  }
});

test("returning to the bottom before a streamed render resumes follow before its scroll event", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.s.scrollTop = 800;
    f.viewport.beforeRender();
    f.grow();
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event("scroll"));
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("a pre-render check leaves readers above the bottom alone", () => {
  const f = fixture();
  try {
    f.scroll(600);
    f.s.scrollTop = 798;
    f.viewport.beforeRender();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 798);
  } finally {
    f.close();
  }
});

test("a pre-render check respects an upward wheel whose scroll has not arrived", () => {
  const f = fixture();
  try {
    f.wheelUp();
    f.viewport.beforeRender();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

test("a pre-render check handles an upward scroll before its event", () => {
  const f = fixture();
  try {
    f.s.scrollTop = 790;
    f.viewport.beforeRender();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 790);
  } finally {
    f.close();
  }
});

test("a deferred scroll event recognizes the previous bottom after asynchronous content growth", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.s.scrollTop = 800;
    f.grow();
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event("scroll"));
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("a measured resize invalidates the previous bottom for readers who have not moved", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.grow();
    f.resize(30, 50);
    f.scroll(800);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

test("passing the previous bottom without reaching the new bottom does not resume follow", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.grow();
    f.scroll(850);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 850);
  } finally {
    f.close();
  }
});

test("the changing streamed reply cannot become the browser's native scroll anchor", () => {
  assert.match(css, /\.streaming-text\.live-stream \{\s*overflow-anchor: none;/);
});

test("a resize callback records a pending return before replacing the measured bottom", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.s.scrollTop = 800;
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("asynchronous growth leaves a reader in place and advances the measured bottom", () => {
  const f = fixture();
  try {
    f.scroll(600);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 600);
    f.scroll(800);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

test("a downward wheel preserves its bottom through multiple layouts before native scrolling", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.WheelEvent("wheel", { deltaY: 300 }));
    f.grow();
    f.resize(30, 50);
    f.grow();
    f.resize(30, 50);
    f.scroll(800);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 1000);
  } finally {
    f.close();
  }
});

test("a compositor scroll can arrive before its delayed wheel event", () => {
  const f = fixture();
  try {
    f.scroll(700);
    const wheel = new f.s.ownerDocument.defaultView!.WheelEvent("wheel", { deltaY: 300 });
    Object.defineProperty(wheel, "timeStamp", { value: 0 });
    f.grow();
    f.resize(30, 50);
    f.s.scrollTop = 800;
    f.s.dispatchEvent(wheel);
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event("scroll"));
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("a fresh wheel after layout cannot resume at an obsolete bottom", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.grow();
    f.resize(30, 50);
    f.s.scrollTop = 800;
    const wheel = new f.s.ownerDocument.defaultView!.WheelEvent("wheel", { deltaY: 100 });
    Object.defineProperty(wheel, "timeStamp", { value: performance.now() + 1 });
    f.s.dispatchEvent(wheel);
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event("scroll"));
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

for (const type of ["pointerdown", "keydown"]) {
  test(`${type} invalidates an unfinished wheel gesture`, () => {
    const f = fixture();
    try {
      f.scroll(700);
      f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.WheelEvent("wheel", { deltaY: 300 }));
      f.grow();
      f.resize(30, 50);
      f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event(type, { bubbles: true }));
      f.scroll(800);
      f.viewport.follow();
      f.flush();
      assert.equal(f.s.scrollTop, 800);
    } finally {
      f.close();
    }
  });
}

test("closing live work preserves following through delayed final markdown layout", () => {
  const f = fixture();
  try {
    f.viewport.beforeRender();
    f.viewport.follow();
    f.collapse();
    f.viewport.afterRender();
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 300);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 400);
  } finally {
    f.close();
  }
});

test("a reader who left the bottom is not pulled back when work closes", () => {
  const f = fixture();
  try {
    f.scroll(100);
    f.viewport.beforeRender();
    f.collapse();
    f.viewport.afterRender();
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 100);
  } finally {
    f.close();
  }
});

test("upward input after work closes still cancels the queued follow", () => {
  const f = fixture();
  try {
    f.viewport.beforeRender();
    f.collapse();
    f.viewport.afterRender();
    f.wheelUp();
    f.scroll(190);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 190);
  } finally {
    f.close();
  }
});

test("an explicit new send re-arms following after reading older messages", () => {
  const f = fixture();
  try {
    f.scroll(100);
    f.viewport.follow(true);
    f.grow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
    f.scroll(500);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 500);
  } finally {
    f.close();
  }
});

for (const reading of [false, true]) {
  test(`asynchronous Markdown replacement preserves ${reading ? "reader position" : "following"}`, async () => {
    const f = fixture();
    try {
      if (reading) f.scroll(100);
      f.viewport.beforeRender();
      f.viewport.afterRender();
      const completion = Promise.withResolvers<void>();
      f.prompt.dispatchEvent(
        new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
          bubbles: true,
          detail: completion.promise,
        }),
      );
      f.collapse();
      completion.resolve();
      await completion.promise;
      f.grow();
      f.resize(30, 50);
      f.flush();
      assert.equal(f.s.scrollTop, reading ? 100 : 300);
    } finally {
      f.close();
    }
  });
}

test("an in-flight Markdown layout cannot be mistaken for reader scrolling", async () => {
  const f = fixture();
  try {
    const completion = Promise.withResolvers<void>();
    f.prompt.dispatchEvent(
      new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
        bubbles: true,
        detail: completion.promise,
      }),
    );
    f.s.scrollTop = 787;
    f.viewport.beforeRender();
    f.grow();
    completion.resolve();
    await completion.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("following waits for every overlapping render, including rejected updates", async () => {
  const f = fixture();
  try {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    for (const completion of [first, second]) {
      f.prompt.dispatchEvent(
        new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
          bubbles: true,
          detail: completion.promise,
        }),
      );
    }
    f.grow();
    first.reject(new Error("render failed"));
    await first.promise.catch(() => {});
    f.flush();
    assert.equal(f.s.scrollTop, 800);
    second.resolve();
    await second.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("a disposed render cannot release a new render on the same scroller", async () => {
  const f = fixture();
  try {
    const start = () => {
      const completion = Promise.withResolvers<void>();
      f.prompt.dispatchEvent(
        new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
          bubbles: true,
          detail: completion.promise,
        }),
      );
      return completion;
    };
    const old = start();
    f.viewport.dispose();
    f.viewport.sync(f.s);
    f.viewport.follow(true);
    f.flush();
    const current = start();
    f.grow();
    old.resolve();
    await old.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 800);
    current.resolve();
    await current.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("End on the transcript resumes following even when layout grows before scrolling", () => {
  const f = fixture();
  try {
    f.scroll(200);
    const event = new f.s.ownerDocument.defaultView!.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    });
    f.s.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    f.grow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 1000);
  } finally {
    f.close();
  }
});

test("End inside a nested control retains the control's native behavior", () => {
  const f = fixture();
  try {
    f.scroll(200);
    const input = f.s.ownerDocument.createElement("textarea");
    f.s.append(input);
    const event = new f.s.ownerDocument.defaultView!.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 200);
  } finally {
    f.close();
  }
});
