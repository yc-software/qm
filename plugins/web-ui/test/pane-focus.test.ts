import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { focusComposerOnPaneClick, preservingFocus, replaceChildrenPreservingFocus } from "../src/pane-focus.ts";

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
  assert.match(focusPane, /preservingFocus\(document, \(\) => activatePanel\(panel\)\)/, "activation drops focus");
});

function clickFixture(secondContent = '<textarea class="composer-input">draft</textarea>') {
  const dom = new JSDOM(`
    <main>
      <section id="first">
        <textarea class="composer-input"></textarea>
      </section>
      <section id="second">
        <p>message</p>
        ${secondContent}
      </section>
    </main>
  `);
  const doc = dom.window.document;
  const host = doc.querySelector("main")!;
  const first = doc.querySelector<HTMLElement>("#first")!;
  const second = doc.querySelector<HTMLElement>("#second")!;
  let active = first;
  focusComposerOnPaneClick(second, () => active === second);
  first.querySelector("textarea")!.focus();
  function click(target: Element, options: MouseEventInit = {}, intervening?: () => void) {
    target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, ...options }));
    second.focus();
    active = second;
    intervening?.();
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
  }
  return { dom, doc, host, first, second, click };
}

test("switching panes by clicking content focuses the new composer without scrolling or moving its caret", () => {
  const { doc, second, click } = clickFixture();
  const composer = second.querySelector("textarea")!;
  composer.setSelectionRange(2, 2);
  const focus = composer.focus.bind(composer);
  composer.focus = (options) => {
    assert.deepEqual(options, { preventScroll: true });
    focus(options);
  };
  click(second.querySelector("p")!);
  assert.equal(doc.activeElement, composer);
  assert.equal(composer.selectionStart, 2);
});

test("clicking the already active pane does not pull focus back to its composer", () => {
  const { doc, second, click } = clickFixture();
  const composer = second.querySelector("textarea")!;
  click(second.querySelector("p")!);
  composer.blur();
  click(second.querySelector("p")!);
  assert.equal(doc.activeElement, second);
});

for (const control of [
  '<a href="#">link</a>',
  "<button><span>button</span></button>",
  "<input>",
  "<textarea></textarea>",
  "<select><option>choice</option></select>",
  "<details><summary>details</summary></details>",
  '<div contenteditable="true"><span>edit</span></div>',
  '<div role="button"><span>action</span></div>',
]) {
  test(`switching panes does not steal focus from ${control}`, () => {
    const { doc, second, click } = clickFixture(
      `<div class="control">${control}</div><textarea class="composer-input"></textarea>`,
    );
    const target = second.querySelector(".control")!.firstElementChild!;
    (target as HTMLElement).tabIndex = 0;
    click(target.querySelector("span, summary") ?? target, {}, () => (target as HTMLElement).focus());
    assert.equal(doc.activeElement, target);
  });
}

for (const options of [{ button: 2 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
  test(`modified pointer click does not focus composer: ${JSON.stringify(options)}`, () => {
    const { doc, second, click } = clickFixture();
    click(second, options);
    assert.equal(doc.activeElement, second);
  });
}

for (const event of ["pointercancel", "dragstart"]) {
  test(`${event} prevents a subsequent click from focusing the composer`, () => {
    const { doc, dom, second, click } = clickFixture();
    click(second, {}, () => second.dispatchEvent(new dom.window.Event(event, { bubbles: true })));
    assert.equal(doc.activeElement, second);
  });
}

test("selecting transcript text while switching panes leaves the selection intact", () => {
  const { doc, second, click } = clickFixture();
  click(second.querySelector("p")!, {}, () => {
    const range = doc.createRange();
    range.selectNodeContents(second.querySelector("p")!);
    doc.getSelection()!.removeAllRanges();
    doc.getSelection()!.addRange(range);
  });
  assert.equal(doc.getSelection()!.toString(), "message");
  assert.equal(doc.activeElement, second);
});

for (const content of ["", '<textarea class="composer-input" disabled></textarea>']) {
  test(`panes without an enabled composer do not receive input focus: ${content}`, () => {
    const { doc, second, click } = clickFixture(content);
    click(second);
    assert.equal(doc.activeElement, second);
  });
}

test("a prevented click does not focus the composer", () => {
  const { doc, second, click } = clickFixture();
  const target = second.querySelector("p")!;
  target.addEventListener("click", (event) => event.preventDefault());
  click(target);
  assert.equal(doc.activeElement, second);
});

test("keyboard-generated clicks do not reuse the last pointer activation", () => {
  const { doc, dom, first, second, click } = clickFixture();
  click(second);
  first.querySelector("textarea")!.focus();
  second.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.activeElement, first.querySelector("textarea"));
});

test("switching panes preserves focus on an unfamiliar keyboard control", () => {
  const { doc, second, click } = clickFixture(
    '<div tabindex="0">custom control</div><textarea class="composer-input"></textarea>',
  );
  const control = second.querySelector<HTMLElement>("[tabindex]")!;
  click(control, {}, () => control.focus());
  assert.equal(doc.activeElement, control);
});
