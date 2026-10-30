import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("Retry remains pointer-targetable inside a sticky user prompt", () => {
  const dom = new JSDOM(
    `<div class="message-stack"><article class="user-row latest-prompt"><div class="user-bubble">Example message</div><div class="send-failure"><span>Message was not sent.</span><button class="btn compact" type="button">Retry</button></div></article></div>`,
    { url: "http://localhost/" },
  );
  try {
    const style = dom.window.document.createElement("style");
    style.textContent = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
    dom.window.document.head.append(style);
    const readStyle = (selector: string) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    assert.equal(readStyle(".user-row").pointerEvents, "none");
    assert.notEqual(readStyle(".user-bubble").pointerEvents, "none");
    assert.notEqual(readStyle(".send-failure button").pointerEvents, "none");
  } finally {
    dom.window.close();
  }
});
