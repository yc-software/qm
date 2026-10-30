import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const { document } = dom.window;
const style = document.createElement("style");
style.textContent = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
document.head.append(style);

function mount(status: string, entry = "roll"): void {
  document.body.innerHTML = `<details class="work work-fold work-${status}"><summary class="work-head"><span class="work-step-slot"><span class="work-step work-step-enter-${entry}"><span class="work-step-icon"><span class="tool-icon work-step-out"><svg></svg></span><span class="tool-icon"><svg></svg></span></span><span class="work-step-label"><span class="work-step-out" aria-hidden="true">Reading</span><span class="sheen-label">Worked</span></span></span></span></summary></details>`;
}

function animation(selector: string): string {
  return dom.window.getComputedStyle(document.querySelector(selector)!).getPropertyValue("animation");
}

test("only the live work head animates its step label and icon", () => {
  for (const status of ["working", "thinking"]) {
    mount(status);
    assert.match(animation(".work-step-label > .sheen-label"), /work-step-in/);
    assert.match(animation(".work-step-label .work-step-out"), /work-step-out/);
    assert.match(animation(".work-step-icon .tool-icon:not(.work-step-out)"), /work-icon-in/);
    assert.match(animation(".work-step-icon .tool-icon.work-step-out"), /work-icon-out/);
    mount(status, "still");
    assert.doesNotMatch(animation(".work-step-icon .tool-icon:not(.work-step-out)"), /work-/);
    mount(status, "fade");
    assert.match(animation(".work-step-icon .tool-icon:not(.work-step-out)"), /work-step-in/);
  }
  for (const status of ["complete", "failed"]) {
    mount(status);
    assert.doesNotMatch(animation(".work-step-label > .sheen-label"), /work-step-in/);
    assert.doesNotMatch(animation(".work-step-icon .tool-icon:not(.work-step-out)"), /work-/);
  }
});
