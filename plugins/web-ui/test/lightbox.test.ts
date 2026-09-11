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
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
if (typeof dom.window.HTMLDialogElement.prototype.showModal !== "function") {
  dom.window.HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
after(() => vite.close());
const { openLightbox } = (await vite.ssrLoadModule("/src/lightbox.ts")) as typeof import("../src/lightbox.ts");

const images = [
  { src: "data:image/png;base64,AAA", name: "one.png" },
  { src: "/api/files/two/content", name: "two.jpg", href: "/api/files/two/content" },
  { src: "/api/files/three/content", name: "three.webp", href: "/api/files/three/content" },
];
const opener = dom.window.document.querySelector<HTMLButtonElement>("#opener")!;

function dialog(): HTMLDialogElement | null {
  return dom.window.document.querySelector<HTMLDialogElement>(".lightbox");
}

function shown(): string | undefined {
  return dialog()?.querySelector("img")?.getAttribute("alt") ?? undefined;
}

function press(name: string): KeyboardEvent {
  const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  dialog()!.dispatchEvent(event);
  return event as unknown as KeyboardEvent;
}

test("opening shows the clicked image with a download link and focuses close", () => {
  openLightbox(images, 1, opener);
  assert.ok(dialog()?.open);
  assert.equal(shown(), "two.jpg");
  const link = dialog()!.querySelector<HTMLAnchorElement>("a[download]")!;
  assert.equal(link.getAttribute("href"), "/api/files/two/content");
  assert.equal(link.getAttribute("download"), "two.jpg");
  assert.equal(dom.window.document.activeElement, dialog()!.querySelector(".lightbox-close"));
  dialog()!.querySelector<HTMLElement>(".lightbox-close")!.click();
  assert.equal(dialog(), null);
  assert.equal(dom.window.document.activeElement, opener);
});

test("arrow keys and buttons step through the message's images and wrap", () => {
  openLightbox(images, 99);
  assert.equal(shown(), "three.webp", "an out-of-range start index is clamped");
  press("ArrowRight");
  assert.equal(shown(), "one.png");
  press("ArrowLeft");
  assert.equal(shown(), "three.webp");
  dialog()!.querySelector<HTMLElement>(".lightbox-nav.next")!.click();
  assert.equal(shown(), "one.png");
  dialog()!.querySelector<HTMLElement>(".lightbox-nav.prev")!.click();
  assert.equal(shown(), "three.webp");
  press("Escape");
});

test("a single image has no navigation and downloads its inline data", () => {
  openLightbox([images[0]!], 0);
  assert.equal(dialog()!.querySelector(".lightbox-nav"), null);
  assert.equal(dialog()!.querySelector("a[download]")?.getAttribute("href"), images[0]!.src);
  press("ArrowRight");
  assert.equal(shown(), "one.png");
  press("Escape");
});

test("Escape closes without reaching page-level handlers and returns focus", () => {
  openLightbox(images, 2, opener);
  let reachedDocument = 0;
  const count = () => reachedDocument++;
  dom.window.document.addEventListener("keydown", count);
  const escape = press("Escape");
  dom.window.document.removeEventListener("keydown", count);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(reachedDocument, 0);
  assert.equal(dialog(), null);
  assert.equal(dom.window.document.activeElement, opener);
});

test("clicking the backdrop closes, clicking the image does not", () => {
  openLightbox(images, 0);
  dialog()!.querySelector<HTMLImageElement>("img")!.click();
  assert.ok(dialog());
  dialog()!.click();
  assert.equal(dialog(), null);
});
