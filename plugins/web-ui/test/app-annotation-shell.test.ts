import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { ANNOTATE_BUTTON, ANNOTATE_JS, ANNOTATE_MARKUP, appAnnotationAsset } from "../../../src/deploy/app-annotate.ts";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function fixture(t: TestContext) {
  const dom = new JSDOM(
    `<body>${ANNOTATE_BUTTON}<iframe id="app"></iframe><iframe id="chat"></iframe>${ANNOTATE_MARKUP}</body>`,
    { url: "https://demo.apps.example.com/", runScripts: "outside-only", pretendToBeVisual: true },
  );
  t.after(() => dom.window.close());
  const w = dom.window;
  const app = w.document.querySelector<HTMLIFrameElement>("#app")!;
  const chat = w.document.querySelector<HTMLIFrameElement>("#chat")!;
  const posts: Record<string, any>[] = [];
  let ack = true;
  chat.contentWindow!.postMessage = (data: any) => {
    posts.push(data);
    if (ack)
      w.dispatchEvent(
        new w.MessageEvent("message", {
          source: chat.contentWindow,
          origin: "https://portal.example.com",
          data: { type: "qm:annotations-ack", id: data.id },
        }),
      );
  };
  w.eval(
    `(() => { const app = document.getElementById("app"), chat = document.getElementById("chat"); const portalOrigin = "https://portal.example.com"; const setOpen = () => {}; ${ANNOTATE_JS} })()`,
  );
  const send = (
    annotations: unknown[],
    scope = "page",
    source: unknown = app.contentWindow,
    origin = w.location.origin,
  ) =>
    w.dispatchEvent(
      new w.MessageEvent("message", {
        source: source as Window,
        origin,
        data: {
          type: "qm:devbar-snapshot",
          payload: {
            scope,
            url: "https://demo.apps.example.com/reports",
            viewport: { width: 1000, height: 800 },
            annotations,
          },
        },
      }),
    );
  return {
    w,
    app,
    chat,
    posts,
    send,
    setAck: (value: boolean) => {
      ack = value;
    },
  };
}
const item = (id = "one", note = "Make this clearer") => ({
  id,
  type: "element",
  data: { cssSelector: "#details", tagName: "BUTTON" },
  comments: [{ text: note }],
});
test("annotations attach automatically, deduplicate, update in place and delete", async (t) => {
  const f = fixture(t);
  f.send([item()]);
  await tick();
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!.text, /Make this clearer/);
  assert.match(f.posts[0]!.text, /#details/);
  assert.equal(f.w.document.querySelector("#ann-send"), null);
  f.send([item()]);
  await tick();
  assert.equal(f.posts.length, 1);
  f.send([item("one", "Updated note")]);
  await tick();
  assert.equal(f.posts[0]!.annotationId, f.posts[1]!.annotationId);
  f.send([]);
  await tick();
  assert.equal(f.posts[2]!.remove, true);
  assert.equal(f.posts[2]!.annotationId, f.posts[0]!.annotationId);
});
test("navigation preserves previous attachments and untrusted windows cannot inject", async (t) => {
  const f = fixture(t);
  f.send([item()]);
  await tick();
  f.send([], "next-page");
  await tick();
  assert.equal(f.posts.length, 1);
  f.send([item()], "next-page");
  await tick();
  assert.notEqual(f.posts[0]!.annotationId, f.posts[1]!.annotationId);
  f.send([item("evil")], "page", f.chat.contentWindow);
  f.send([item("evil")], "page", f.app.contentWindow, "https://evil.example.com");
  await tick();
  assert.equal(f.posts.length, 2);
});
test("delivery is single flight while waiting for chat and preserves latest edits", async (t) => {
  const f = fixture(t);
  f.setAck(false);
  f.send([item()]);
  await tick();
  f.send([item("one", "latest")]);
  await tick();
  assert.equal(f.posts.length, 1);
  f.setAck(true);
  f.w.dispatchEvent(
    new f.w.MessageEvent("message", {
      source: f.chat.contentWindow,
      origin: "https://portal.example.com",
      data: { type: "qm:annotations-ack", id: f.posts[0]!.id },
    }),
  );
  await tick();
  assert.equal(f.posts.length, 2);
  assert.match(f.posts[1]!.text, /latest/);
});
test("navigation drains every pending page after delayed chat acknowledgement", async (t) => {
  const f = fixture(t);
  f.setAck(false);
  f.send([item("one"), item("two")], "page-a");
  await tick();
  f.send([item("one")], "page-b");
  await tick();
  assert.equal(f.posts.length, 1);
  f.setAck(true);
  f.w.dispatchEvent(
    new f.w.MessageEvent("message", {
      source: f.chat.contentWindow,
      origin: "https://portal.example.com",
      data: { type: "qm:annotations-ack", id: f.posts[0]!.id },
    }),
  );
  await tick();
  assert.deepEqual(
    f.posts.map((post) => post.annotationId.split(":").slice(1).join(":")),
    ["page-a:one", "page-a:two", "page-b:one"],
  );
  f.send([item("two", "Updated after navigation")], "page-a");
  await tick();
  assert.equal(f.posts[3]!.annotationId, f.posts[0]!.annotationId);
  assert.equal(f.posts[3]!.remove, true);
  assert.equal(f.posts[4]!.annotationId, f.posts[1]!.annotationId);
  assert.match(f.posts[4]!.text, /Updated after navigation/);
  assert.equal(f.posts.length, 5);
});
test("bundled Devbar mounts original controls without Copy, Export or Agent", async (t) => {
  const dom = new JSDOM("<!doctype html><body><button>App button</button></body>", {
    url: "https://demo.apps.example.com/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.defineProperty(w, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(w, "ResizeObserver", {
    value: class {
      observe() {}
      disconnect() {}
    },
  });
  w.eval(appAnnotationAsset("js"));
  const toggle = (on: boolean, chatOpen = false) =>
    w.dispatchEvent(
      new w.MessageEvent("message", {
        source: w as unknown as Window,
        origin: w.location.origin,
        data: { type: "qm:devbar-toggle", on, chatOpen },
      }),
    );
  toggle(true);
  for (let attempt = 0; attempt < 100 && !w.document.querySelector(".devbar-minibar-tool"); attempt++) await tick();
  assert.equal(w.document.querySelector('[aria-label="Select tool"]')?.getAttribute("aria-pressed"), "true");
  assert.deepEqual(
    [...w.document.querySelectorAll(".devbar-minibar-tool")].map((b) => b.getAttribute("data-shortcut")),
    ["S", "M", "D", "C"],
  );
  const snapshots: any[] = [];
  w.addEventListener("message", (event) => {
    if (event.data?.type === "qm:devbar-snapshot") snapshots.push(event.data.payload);
  });
  toggle(false, true);
  let quoteRect = new w.DOMRect(10, 10, 90, 20);
  w.Range.prototype.getBoundingClientRect = () => quoteRect;
  const appButton = w.document.querySelector("body > button")!;
  appButton.getBoundingClientRect = () => new w.DOMRect(200, 200, 400, 200);
  await tick();
  w.document.elementFromPoint = () => appButton;
  appButton.dispatchEvent(new w.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
  const range = w.document.createRange();
  range.setStart(appButton.firstChild!, 0);
  range.setEnd(appButton.firstChild!, 3);
  w.getSelection()!.addRange(range);
  appButton.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
  await tick();
  assert.equal(snapshots.flatMap((snapshot) => snapshot.annotations).length, 0);
  assert.equal(w.document.querySelector('[data-devbar="quote-prompt"]'), null);
  const note = w.document.querySelector<HTMLInputElement>('[data-devbar="note-input"] input')!;
  assert.ok(note, "highlighting immediately opens the shared comment editor");
  const quoteEditor = note.closest<HTMLElement>('[data-devbar="note-input"]')!;
  assert.equal(quoteEditor.style.left, "10px");
  assert.equal(quoteEditor.style.top, "38px");
  quoteRect = new w.DOMRect(40, 50, 90, 20);
  w.dispatchEvent(new w.Event("scroll"));
  await tick();
  assert.equal(quoteEditor.style.left, "40px");
  assert.equal(quoteEditor.style.top, "78px");
  for (const key of ["a", "s", "m", "d", "c"])
    note.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true }));
  assert.equal(w.document.querySelector<HTMLElement>("[data-devbar=root]")?.dataset.passive, "true");
  [...w.document.querySelectorAll<HTMLButtonElement>('[data-devbar="note-input"] button')]
    .find((button) => button.textContent?.startsWith("Save"))!
    .click();
  await tick();
  await tick();
  const quote = snapshots
    .flatMap((snapshot) => snapshot.annotations)
    .find((annotation) => annotation.data?.textSelection);
  assert.equal(quote.data.textSelection.exact, "App");
  assert.equal(quote.comments.length, 0);
  assert.equal(quote.data.textSelection.suffix, " button");
  assert.equal(quote.data.textSelection.start.xpath, "/html[1]/body[1]/button[1]/text()[1]");
  assert.equal(w.document.querySelector('[data-devbar="note-input"]'), null);
  const savedQuote = w.document.querySelector<HTMLElement>(".devbar-selection-marker-clickable")!;
  assert.equal(savedQuote.style.left, "38px");
  assert.equal(savedQuote.style.top, "48px");
  assert.equal(savedQuote.style.width, "94px");
  assert.equal(savedQuote.style.height, "24px");
  quoteRect = new w.DOMRect(80, 90, 120, 30);
  await tick();
  assert.equal(savedQuote.style.left, "78px");
  assert.equal(savedQuote.style.top, "88px");
  assert.equal(savedQuote.style.width, "124px");
  assert.equal(savedQuote.style.height, "34px");
  savedQuote.click();
  await tick();
  const quoteThread = w.document.querySelector<HTMLElement>('[data-devbar="thread-popover"]')!;
  assert.ok(quoteThread, "saved quotes open the shared annotation editor");
  assert.equal(quoteThread.style.left, "212px");
  assert.equal(quoteThread.style.top, "90px");
  quoteThread.querySelector<HTMLButtonElement>('button[title="Close"]')!.click();
  await tick();
  toggle(false);
  await tick();
  toggle(true);
  await tick();
  assert.equal(w.document.querySelector('[aria-label="Select tool"]')?.getAttribute("aria-pressed"), "true");
  w.dispatchEvent(new w.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
  await tick();
  await tick();
  assert.equal(snapshots.at(-1).annotations.length, 0, "Devbar undo removes text quotes from its shared state");
  [...w.document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.title === "Finish using tool (Esc)")!
    .click();
  await tick();
  const buttons = [...w.document.querySelectorAll("[data-devbar] button")].map((b) => b.textContent);
  for (const tool of ["Select", "Draw", "Capture"]) assert.ok(buttons.some((b) => b?.includes(tool)));
  assert.ok(!buttons.some((b) => /Copy|Export|Agent/.test(b || "")));
  const capture = [...w.document.querySelectorAll<HTMLButtonElement>("[data-devbar] button")].find((button) =>
    button.textContent?.startsWith("Capture"),
  )!;
  capture.click();
  await tick();
  const overlay = w.document.querySelector("[data-devbar=capture-overlay]")!;
  let screenshotReads = 0;
  const readStyle = w.getComputedStyle.bind(w);
  w.getComputedStyle = (element) => {
    screenshotReads++;
    return readStyle(element);
  };
  overlay.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }));
  overlay.dispatchEvent(new w.MouseEvent("mousemove", { bubbles: true, clientX: 110, clientY: 90 }));
  overlay.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true, clientX: 110, clientY: 90 }));
  await tick();
  assert.ok(screenshotReads > 0, "a fast drag starts screenshot capture without waiting for a React render");
  toggle(false);
  await tick();
  assert.equal(w.document.querySelector("[data-devbar=root]")?.hasAttribute("hidden"), true);
});
