import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<div class="sidebar" data-tip-placement="right"><button id="rail"></button></div>
   <button id="pane"></button><button id="edge"></button>`,
);
Object.assign(globalThis, { document: dom.window.document, window: dom.window });

const { attachTooltip, hideTooltip } = await import("../src/tooltip.ts");

function rect(left: number, top: number, width = 34, height = 34) {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

function hover(id: string, label: string): HTMLElement {
  const target = dom.window.document.querySelector<HTMLElement>(`#${id}`)!;
  attachTooltip(target, label);
  target.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  const tip = dom.window.document.querySelector<HTMLElement>(".qm-tooltip")!;
  tip.getBoundingClientRect = () => rect(0, 0, 56, 24) as DOMRect;
  target.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  return tip;
}

test("a tooltip inside a right-placement container sits beside the target, vertically centred", () => {
  const target = dom.window.document.querySelector<HTMLElement>("#rail")!;
  target.getBoundingClientRect = () => rect(8, 180) as DOMRect;
  const tip = hover("rail", "Browse");
  assert.equal(tip.style.left, "49px");
  assert.equal(tip.style.top, "185px");
  hideTooltip(target);
});

test("tooltips outside that container keep the default placement above the target", () => {
  const target = dom.window.document.querySelector<HTMLElement>("#pane")!;
  target.getBoundingClientRect = () => rect(500, 300) as DOMRect;
  const tip = hover("pane", "Refresh");
  assert.equal(tip.style.left, "489px");
  assert.equal(tip.style.top, "269px");
  hideTooltip(target);
});

test("a right-placed tooltip with no room beside it falls back to the default placement", () => {
  const target = dom.window.document.querySelector<HTMLElement>("#edge")!;
  target.getBoundingClientRect = () => rect(dom.window.innerWidth - 40, 300) as DOMRect;
  dom.window.document.querySelector(".sidebar")!.appendChild(target);
  const tip = hover("edge", "Cramped");
  assert.equal(tip.style.top, "269px");
  assert.equal(tip.style.left, `${dom.window.innerWidth - 56 - 6}px`);
  hideTooltip(target);
});
