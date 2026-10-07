import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Check, X } from "lucide";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Document",
  "CSSStyleSheet",
  "ShadowRoot",
  "customElements",
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { html, render } = await import("lit");
const { icon, waveLoader, workingWave, setFormMenuValue } = await import("../src/ui.ts");

test("unchanged icon templates keep their DOM while separate placements remain independent", () => {
  const host = document.createElement("div");
  const draw = (node = Check, size = 18) =>
    render(html`<button>${icon(node, size)}</button><button>${icon(Check, 18)}</button>`, host);
  draw();
  const first = host.querySelector("svg")!;
  const second = host.querySelectorAll("svg")[1]!;
  assert.notEqual(first, second);
  draw();
  assert.equal(host.querySelector("svg"), first);
  assert.equal(host.querySelectorAll("svg")[1], second);
  draw(X, 14);
  assert.notEqual(host.querySelector("svg"), first);
  assert.equal(host.querySelector("svg")!.getAttribute("width"), "14");
  assert.equal(host.querySelectorAll("svg")[1], second);
});

test("imperative menu checks remain real SVG nodes", () => {
  const control = document.createElement("div");
  control.innerHTML =
    '<input type="hidden"><span class="menu-label"></span><button class="menu-option" data-value="a">A</button><button class="menu-option" data-value="b">B</button>';
  setFormMenuValue(control, "a", "A");
  setFormMenuValue(control, "b", "B");
  assert.equal(control.querySelectorAll("svg").length, 1);
  assert.equal(control.querySelector(".active")?.getAttribute("data-value"), "b");
});

test("wave animation moves a root SVG inside a fixed-size accessible clip", () => {
  const host = document.createElement("div");
  render(workingWave(), host);
  const clip = host.querySelector<HTMLElement>(".wl")!;
  assert.equal(clip.localName, "span");
  assert.equal(clip.style.width, "13.6px");
  assert.equal(clip.style.height, "5.7px");
  assert.equal(clip.style.getPropertyValue("--wl-shift"), "-8.5px");
  assert.equal(clip.getAttribute("aria-label"), "Agent is working");
  assert.equal(clip.querySelector(".wl-row")?.localName, "svg");
  assert.equal(clip.querySelector("g"), null);
  render(waveLoader(), host);
  assert.equal(host.querySelector<HTMLElement>(".wl")!.style.width, "24.5px");
});
