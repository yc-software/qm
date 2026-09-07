import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM('<!doctype html><button id="opener">open</button>', { url: "http://localhost/" });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLDialogElement: dom.window.HTMLDialogElement,
  Image: dom.window.Image,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  TouchEvent: dom.window.TouchEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
if (typeof dom.window.HTMLDialogElement.prototype.showModal !== "function") {
  dom.window.HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
if (typeof dom.window.Element.prototype.scrollIntoView !== "function") {
  dom.window.Element.prototype.scrollIntoView = () => {};
}
let naturalSize = 0;
Object.defineProperty(dom.window.HTMLImageElement.prototype, "naturalWidth", { get: () => naturalSize });
Object.defineProperty(dom.window.HTMLImageElement.prototype, "naturalHeight", { get: () => naturalSize });

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
after(() => vite.close());
const { openLightbox } = (await vite.ssrLoadModule("/src/lightbox.ts")) as typeof import("../src/lightbox.ts");

const images = [
  { src: "data:image/png;base64,AAA", name: "one.png", size: 1024 },
  { src: "/api/files/two/content", name: "two.jpg", size: 2048, href: "/api/files/two/content" },
  { src: "/api/files/three/content", name: "three.webp", href: "/api/files/three/content" },
];

function dialog(): HTMLDialogElement | null {
  return dom.window.document.querySelector<HTMLDialogElement>(".lightbox");
}

function text(selector: string): string {
  return dialog()?.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function shown(): string {
  return text(".lightbox-name");
}

function press(name: string): KeyboardEvent {
  const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  dialog()!.dispatchEvent(event);
  return event as unknown as KeyboardEvent;
}

function click(selector: string, index = 0): void {
  dialog()!.querySelectorAll<HTMLElement>(selector)[index]!.click();
}

function swipe(fromX: number, toX: number): void {
  const stage = dialog()!.querySelector<HTMLElement>(".lightbox-stage")!;
  for (const [type, clientX] of [
    ["touchstart", fromX],
    ["touchend", toX],
  ] as const) {
    const event = new dom.window.Event(type, { bubbles: true });
    Object.defineProperty(event, "changedTouches", { value: [{ clientX }] });
    stage.dispatchEvent(event);
  }
}

function close(): void {
  click(".lightbox-close");
  assert.equal(dialog(), null);
}

test("opening shows the clicked image with its position, name, size and links", () => {
  openLightbox(images, 1);
  assert.ok(dialog()?.open, "the viewer opens as a modal dialog");
  assert.equal(text(".lightbox-count"), "2 / 3");
  assert.equal(shown(), "two.jpg");
  assert.equal(text(".lightbox-title small"), "2 KB");
  assert.equal(text('[role="status"]'), "Image 2 of 3: two.jpg");
  const links = [...dialog()!.querySelectorAll<HTMLAnchorElement>("a.lightbox-btn")];
  assert.deepEqual(
    links.map((a) => [a.getAttribute("href"), a.getAttribute("download") ?? a.getAttribute("target")]),
    [
      ["/api/files/two/content", "two.jpg"],
      ["/api/files/two/content", "_blank"],
    ],
  );
  assert.equal(dialog()!.querySelectorAll(".lightbox-thumb").length, 3);
  assert.equal(dialog()!.querySelector(".lightbox-thumb.current")?.getAttribute("title"), "two.jpg");
  close();
});

test("arrow keys step through the gallery and wrap at both ends", () => {
  openLightbox(images, 0);
  press("ArrowRight");
  assert.equal(shown(), "two.jpg");
  press("ArrowRight");
  press("ArrowRight");
  assert.equal(shown(), "one.png", "stepping past the last image wraps to the first");
  press("ArrowLeft");
  assert.equal(shown(), "three.webp", "stepping before the first image wraps to the last");
  press("Home");
  assert.equal(shown(), "one.png");
  press("End");
  assert.equal(shown(), "three.webp");
  assert.equal(text(".lightbox-count"), "3 / 3");
  close();
});

test("arrow buttons and filmstrip thumbnails navigate", () => {
  openLightbox(images, 0);
  click(".lightbox-nav.next");
  assert.equal(shown(), "two.jpg");
  click(".lightbox-nav.prev");
  assert.equal(shown(), "one.png");
  click(".lightbox-thumb", 2);
  assert.equal(shown(), "three.webp");
  assert.equal(text(".lightbox-count"), "3 / 3");
  close();
});

test("a horizontal swipe on the stage advances, a tap does not", () => {
  openLightbox(images, 0);
  swipe(300, 200);
  assert.equal(shown(), "two.jpg");
  swipe(200, 210);
  assert.equal(shown(), "two.jpg");
  swipe(200, 300);
  assert.equal(shown(), "one.png");
  close();
});

test("zoom unlocks once the image is larger than the stage, and a zoomed image pans instead of swiping", () => {
  openLightbox(images, 0);
  const zoom = () => dialog()!.querySelector<HTMLButtonElement>(".lightbox-zoom")!;
  assert.equal(zoom().disabled, true, "zoom stays disabled until the image proves larger than the stage");
  naturalSize = 4000;
  dialog()!.querySelector<HTMLImageElement>(".lightbox-image")!.dispatchEvent(new dom.window.Event("load"));
  assert.equal(zoom().disabled, false);
  zoom().click();
  assert.equal(dialog()!.classList.contains("zoomed"), true);
  assert.equal(zoom().getAttribute("aria-pressed"), "true");
  swipe(300, 100);
  assert.equal(shown(), "one.png", "panning a zoomed image never changes the picture");
  press("ArrowRight");
  assert.equal(dialog()!.classList.contains("zoomed"), false, "navigating resets zoom");
  naturalSize = 0;
  close();
});

test("a single image hides navigation and links download to its inline data", () => {
  openLightbox([images[0]!], 0);
  assert.equal(dialog()!.querySelector(".lightbox-count"), null);
  assert.equal(dialog()!.querySelector(".lightbox-nav"), null);
  assert.equal(dialog()!.querySelector(".lightbox-strip"), null);
  const links = [...dialog()!.querySelectorAll<HTMLAnchorElement>("a.lightbox-btn")];
  assert.equal(links.length, 1, "no open-original link without a durable href");
  assert.equal(links[0]!.getAttribute("download"), "one.png");
  press("ArrowRight");
  assert.equal(shown(), "one.png");
  close();
});

test("Escape and the close button dismiss the viewer and hand focus back to the opener", async () => {
  const opener = dom.window.document.querySelector<HTMLButtonElement>("#opener")!;
  openLightbox(images, 2, opener);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dom.window.document.activeElement?.className, "lightbox-btn lightbox-close");
  let reachedDocument = 0;
  const countEscape = () => reachedDocument++;
  dom.window.document.addEventListener("keydown", countEscape);
  const escape = press("Escape");
  dom.window.document.removeEventListener("keydown", countEscape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(reachedDocument, 0, "Escape stops at the viewer instead of reaching page-level handlers");
  assert.equal(dialog(), null);
  assert.equal(dom.window.document.activeElement, opener);

  openLightbox(images, 0, opener);
  close();
  assert.equal(dom.window.document.activeElement, opener);
});

test("clicking the empty stage closes, clicking the image does not", () => {
  openLightbox(images, 0);
  dialog()!.querySelector<HTMLImageElement>(".lightbox-image")!.click();
  assert.ok(dialog(), "the image itself is not a close target");
  dialog()!.querySelector<HTMLElement>(".lightbox-stage")!.click();
  assert.equal(dialog(), null);
});

test("an out-of-range start index is clamped", () => {
  openLightbox(images, 99);
  assert.equal(shown(), "three.webp");
  close();
  openLightbox(images, -4);
  assert.equal(shown(), "one.png");
  close();
});
