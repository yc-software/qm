import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<div class="sidebar" data-tip-placement="right"><button id="rail"></button></div>
   <button id="pane"></button>`,
);
Object.assign(globalThis, { document: dom.window.document, window: dom.window });

const { attachTooltip, hideTooltip } = await import("../src/tooltip.ts");

function hover(id: string, label = "Tooltip"): HTMLElement {
  const target = dom.window.document.querySelector<HTMLElement>(`#${id}`)!;
  attachTooltip(target, label);
  target.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  return dom.window.document.querySelector<HTMLElement>(".qm-tooltip")!;
}

const pane = dom.window.document.querySelector<HTMLElement>("#pane")!;
const rail = dom.window.document.querySelector<HTMLElement>("#rail")!;

test("placement delegates to CSS without measuring or writing viewport coordinates", () => {
  pane.getBoundingClientRect = () => {
    throw new Error("JavaScript must not measure tooltip anchors");
  };
  const tip = hover("pane");
  assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), true);
  assert.equal(tip.classList.contains("beside"), false);
  assert.equal(tip.style.left, "");
  assert.equal(tip.style.top, "");
  assert.equal(tip.parentElement, document.body);
  hideTooltip();
});

test("right placement resolves on show and updates when the rail expands", () => {
  const sidebar = rail.parentElement!;
  const tip = hover("rail");
  assert.equal(tip.classList.contains("beside"), true);
  sidebar.removeAttribute("data-tip-placement");
  hover("rail");
  assert.equal(tip.classList.contains("beside"), false);
  sidebar.setAttribute("data-tip-placement", "right");
  hideTooltip();
});

test("switching targets removes the old anchor and ignores its late leave", () => {
  const tip = hover("rail");
  hover("pane", "Attachment");
  assert.equal(rail.hasAttribute("data-qm-tooltip-anchor"), false);
  assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), true);
  assert.equal(document.querySelectorAll("[data-qm-tooltip-anchor]").length, 1);
  hideTooltip(rail);
  assert.equal(tip.classList.contains("visible"), true);
  assert.equal(tip.textContent, "Attachment");
  hideTooltip(pane);
  assert.equal(tip.classList.contains("visible"), false);
  assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), false);
});

test("scrolling does not dismiss the anchored tooltip", () => {
  const tip = hover("pane");
  pane.parentElement!.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(tip.classList.contains("visible"), true);
  assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), true);
  hideTooltip();
});

test("updating text preserves the active target and empty text clears it", () => {
  const tip = hover("pane", "Before");
  attachTooltip(pane, "After");
  assert.equal(tip.textContent, "After");
  assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), true);
  attachTooltip(pane, "");
  assert.equal(tip.classList.contains("visible"), false);
  assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), false);
});

test("focus shows and blur or click removes the tooltip and anchor", () => {
  attachTooltip(pane, "Keyboard label");
  for (const event of ["blur", "click"]) {
    pane.dispatchEvent(new dom.window.Event("focus"));
    assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), true);
    pane.dispatchEvent(new dom.window.Event(event));
    assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), false);
    assert.equal(document.querySelector(".qm-tooltip")!.classList.contains("visible"), false);
  }
});

test("hoverless devices do not create a visible tooltip or anchor", () => {
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  const tip = hover("pane");
  assert.equal(tip.classList.contains("visible"), false);
  assert.equal(pane.hasAttribute("data-qm-tooltip-anchor"), false);
  Reflect.deleteProperty(dom.window, "matchMedia");
});
