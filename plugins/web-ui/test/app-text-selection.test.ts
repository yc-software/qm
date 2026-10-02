import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { readTextSelection, resolveTextSelection } from "../src/app-text-selection.ts";

test("quotes preserve exact text across markup, context and DOM endpoints", () => {
  const dom = new JSDOM("<p>Before <strong>selected</strong> words after.</p>");
  const document = dom.window.document;
  const range = document.createRange();
  range.setStart(document.querySelector("strong")!.firstChild!, 0);
  range.setEnd(document.querySelector("p")!.lastChild!, 6);
  const selection = dom.window.getSelection()!;
  selection.addRange(range);
  const result = readTextSelection(selection)!;
  assert.equal(result.element.tagName, "P");
  assert.deepEqual(result.textSelection, {
    exact: "selected words",
    prefix: "Before ",
    suffix: " after.",
    start: { xpath: "/html[1]/body[1]/p[1]/strong[1]/text()[1]", offset: 0 },
    end: { xpath: "/html[1]/body[1]/p[1]/text()[2]", offset: 6 },
  });
  const restored = resolveTextSelection(result.textSelection, document)!;
  assert.equal(restored.toString(), "selected words");
  assert.equal(restored.startContainer, range.startContainer);
  assert.equal(restored.endOffset, 6);
  document.querySelector("strong")!.textContent = "changed";
  assert.equal(resolveTextSelection(result.textSelection, document), null);
  selection.collapseToEnd();
  assert.equal(readTextSelection(selection), null);
  dom.window.close();
});

test("editing and annotation UI selections do not become app quotes", () => {
  const dom = new JSDOM('<div contenteditable="true">draft</div><div data-devbar="root">toolbar</div>');
  const selection = dom.window.getSelection()!;
  for (const element of dom.window.document.querySelectorAll("div")) {
    const range = dom.window.document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    assert.equal(readTextSelection(selection), null);
  }
  dom.window.close();
});
