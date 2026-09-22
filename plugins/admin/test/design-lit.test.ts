import assert from "node:assert/strict";
import test from "node:test";
import { renderDesign } from "./design-source.ts";
test("Design examples render the complete catalog and reactive save feedback", () => {
  const dom = renderDesign();
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll(".design-group").length, 10);
    assert.equal(doc.querySelectorAll(".design-contents a").length, 10);
    const input = doc.getElementById("design-name") as HTMLInputElement;
    input.focus();
    input.value = "Edited";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(doc.activeElement, input);
    assert.equal(doc.getElementById("design-status")!.textContent!.trim(), "Unsaved changes");
    const button = doc.getElementById("design-apply") as HTMLButtonElement;
    assert.equal(button.disabled, false);
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(doc.getElementById("design-status")!.textContent!.trim(), "Saved in this example");
    doc.getElementById("design-advanced")!.click();
    assert.equal(doc.getElementById("design-pack-advanced")!.classList.contains("hidden"), false);
    doc.getElementById("design-remove-chip")!.click();
    assert.equal(doc.getElementById("design-remove-chip"), null);
    assert.match(doc.getElementById("design-chip-status")!.textContent!, /removed/);
  } finally {
    dom.window.close();
  }
});
