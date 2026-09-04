import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "../src/dialog-focus.ts";

function keyboardEvent(dom: JSDOM, key: string, shiftKey = false): KeyboardEvent {
  return new dom.window.KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  }) as unknown as KeyboardEvent;
}

test("dialog Escape closes without reaching the page behind it", () => {
  const dom = new JSDOM('<div id="dialog"><button>Cancel</button><button>Confirm</button></div>');
  const dialog = dom.window.document.querySelector<HTMLElement>("#dialog")!;
  let closed = 0;
  let escaped = 0;
  dialog.addEventListener("keydown", (event) => trapDialogFocus(event as unknown as KeyboardEvent, () => closed++));
  dom.window.document.addEventListener("keydown", () => escaped++);

  const event = keyboardEvent(dom, "Escape");
  dialog.dispatchEvent(event);

  assert.equal(closed, 1);
  assert.equal(escaped, 0);
  assert.equal(event.defaultPrevented, true);
});

test("dialog Tab focus wraps in both directions", () => {
  const dom = new JSDOM(
    '<div id="dialog"><button id="first">Cancel</button><button disabled>Disabled</button><button id="last">Confirm</button></div>',
  );
  const dialog = dom.window.document.querySelector<HTMLElement>("#dialog")!;
  const first = dom.window.document.querySelector<HTMLButtonElement>("#first")!;
  const last = dom.window.document.querySelector<HTMLButtonElement>("#last")!;
  dialog.addEventListener("keydown", (event) => trapDialogFocus(event as unknown as KeyboardEvent, () => {}));

  last.focus();
  last.dispatchEvent(keyboardEvent(dom, "Tab"));
  assert.equal(dom.window.document.activeElement, first);

  first.focus();
  first.dispatchEvent(keyboardEvent(dom, "Tab", true));
  assert.equal(dom.window.document.activeElement, last);
});

test("closing a dialog returns focus to its opener or its repainted replacement", () => {
  const dom = new JSDOM('<button id="opener">Archive</button><button id="replacement">Archive</button>');
  const opener = dom.window.document.querySelector<HTMLElement>("#opener")!;
  const replacement = dom.window.document.querySelector<HTMLElement>("#replacement")!;

  restoreDialogFocus(opener, () => replacement);
  assert.equal(dom.window.document.activeElement, opener);

  opener.remove();
  restoreDialogFocus(opener, () => replacement);
  assert.equal(dom.window.document.activeElement, replacement);
});

test("destructive dialogs initially focus the safe action", () => {
  const dom = new JSDOM('<div><button data-dialog-cancel>Cancel</button><button class="danger">Delete</button></div>');
  focusDialogCancel(dom.window.document);
  assert.equal(dom.window.document.activeElement?.textContent, "Cancel");
});
