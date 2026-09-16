import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { toggleFormMenu, closeFormMenus } from "../src/ui.ts";

for (const scenario of [
  { name: "opens upward inside a shorter dialog", dialog: true, anchorTop: 340, upward: true },
  { name: "stays downward when the dialog has room", dialog: true, anchorTop: 200, upward: false },
  { name: "keeps viewport placement outside dialogs", dialog: false, anchorTop: 340, upward: false },
  { name: "opens upward at the viewport bottom", dialog: false, anchorTop: 710, upward: true },
]) {
  test(`form menu ${scenario.name}`, () => {
    const dom = new JSDOM(
      `<body>${scenario.dialog ? "<dialog open>" : ""}<div class="form-menu-control"><button class="menu-button"></button><div class="menu-popover" hidden></div></div>${scenario.dialog ? "</dialog>" : ""}</body>`,
    );
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    try {
      const document = dom.window.document;
      const control = document.querySelector<HTMLElement>(".form-menu-control")!;
      const button = document.querySelector<HTMLButtonElement>("button")!;
      const menu = document.querySelector<HTMLElement>(".menu-popover")!;
      const box = (x: number, y: number, width: number, height: number) => new dom.window.DOMRect(x, y, width, height);
      const dialog = document.querySelector("dialog");
      if (dialog) dialog.getBoundingClientRect = () => box(100, 100, 440, 300);
      control.getBoundingClientRect = () => box(300, scenario.anchorTop, 100, 30);
      menu.getBoundingClientRect = () => box(300, scenario.anchorTop + 36, 170, 110);
      button.addEventListener("click", toggleFormMenu);
      button.click();
      assert.equal(menu.hidden, false);
      assert.equal(menu.classList.contains("drop-up"), scenario.upward);
      assert.equal(button.getAttribute("aria-expanded"), "true");
      closeFormMenus();
      assert.equal(menu.hidden, true);
      assert.equal(menu.classList.contains("drop-up"), false);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
      dom.window.close();
    }
  });
}
