import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const { document } = dom.window;
const style = document.createElement("style");
style.textContent = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
document.head.append(style);

function mount(status: string): void {
  document.body.innerHTML = `<details class="work work-fold work-${status}"><summary class="work-head"><span class="work-step-slot"><span class="work-step work-step-out" aria-hidden="true">Reading</span><span class="work-step">Worked</span></span></summary></details>`;
}

function animation(selector: string): string {
  return dom.window.getComputedStyle(document.querySelector(selector)!).getPropertyValue("animation");
}

test("only the live work head fades its step label in", () => {
  for (const status of ["working", "thinking"]) {
    mount(status);
    assert.match(animation(".work-step:not(.work-step-out)"), /work-step-in/);
    assert.match(animation(".work-step-out"), /work-step-out/);
  }
  for (const status of ["complete", "failed"]) {
    mount(status);
    assert.doesNotMatch(animation(".work-step:not(.work-step-out)"), /work-step-in/);
  }
});
