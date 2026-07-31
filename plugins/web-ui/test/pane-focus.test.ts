import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { preservingFocus, replaceChildrenPreservingFocus } from "../src/pane-focus.ts";

test("re-rendered pane inputs keep focus and caret across multi-character typing", () => {
  const dom = new JSDOM('<main><div><input data-focus-key="search" value="a"></div></main>');
  const main = dom.window.document.querySelector("main") as HTMLElement;
  const first = main.querySelector("input")!;
  first.focus();
  first.setSelectionRange(1, 1);

  for (const value of ["ab", "abc", "abcd"]) {
    const host = dom.window.document.createElement("div");
    host.innerHTML = `<input data-focus-key="search" value="${value}">`;
    replaceChildrenPreservingFocus(main, host);
    const next = main.querySelector("input")!;
    assert.equal(dom.window.document.activeElement, next);
    assert.equal(next.selectionStart, value.length - 1);
    next.setSelectionRange(value.length, value.length);
  }
});

test("activating a pane cannot cost the composer its focus or caret", () => {
  const dom = new JSDOM('<div class="dock"><div class="pane"><textarea>hi</textarea></div></div>');
  const doc = dom.window.document;
  const dock = doc.querySelector(".dock") as HTMLElement;
  const pane = doc.querySelector(".pane") as HTMLElement;
  const ta = doc.querySelector("textarea")!;
  ta.focus();
  ta.setSelectionRange(1, 1);

  preservingFocus(doc, () => {
    pane.remove();
    dock.appendChild(pane);
  });

  assert.equal(doc.activeElement, ta);
  assert.equal(ta.selectionStart, 1);
});

test("a pane focusin never re-activates the pane it is already in", () => {
  const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
  const focusPane = split.match(/function focusPane\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(focusPane, "focusPane not found");
  assert.match(focusPane, /if \(!panel \|\| panel\.api\.isActive\) return;/, "re-activation remounts the pane");
  assert.match(focusPane, /preservingFocus\(document, \(\) => panel\.api\.setActive\(\)\)/, "activation drops focus");
});
