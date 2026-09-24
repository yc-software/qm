import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  MutationObserver: dom.window.MutationObserver,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Document: dom.window.Document,
  CSSStyleSheet: dom.window.CSSStyleSheet,
});
const { html, render } = await import("lit");
const { annotate, annotationText } = await import("../src/annotation.ts");
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect(30, 30, 120, 20);

test("annotations preserve multiline quotes and separate the comment", () => {
  assert.equal(annotationText("first\nsecond", "Please shorten this"), "> first\n> second\n\nPlease shorten this");
});

test("selection stages a quote and comment only after explicit add, and cleans up on navigation", () => {
  const host = document.createElement("main");
  document.body.append(host);
  const added: string[] = [];
  const draw = (key: string) =>
    render(
      html`<section ${annotate({ key, selector: "p", add: (text) => added.push(text) })}>
        <p>Selected passage</p>
        <p>Another passage</p>
      </section>`,
      host,
    );
  draw("first");
  const select = () => {
    const p = host.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    p.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  };
  select();
  document.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
  const input = document.querySelector<HTMLTextAreaElement>(".annotation-popover textarea")!;
  input.value = "Explain this";
  input.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(added, []);
  document.querySelector<HTMLButtonElement>(".annotation-actions .primary")!.click();
  assert.deepEqual(added, ["> Selected passage\n\nExplain this"]);
  assert.equal(document.querySelector(".annotation-popover"), null);
  select();
  draw("second");
  assert.equal(document.querySelector(".annotation-popover"), null);
  render(html``, host);
  host.remove();
});

test("draft textarea selection uses the selected substring", () => {
  const host = document.createElement("main");
  document.body.append(host);
  const added: string[] = [];
  render(
    html`<section ${annotate({ key: "draft", selector: ".draft", add: (text) => added.push(text) })}>
      <textarea class="draft">Hello world</textarea>
    </section>`,
    host,
  );
  const draft = host.querySelector("textarea")!;
  draft.setSelectionRange(6, 11);
  draft.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  document.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
  const comment = document.querySelector<HTMLTextAreaElement>(".annotation-popover textarea")!;
  comment.value = "Change this";
  comment.dispatchEvent(new dom.window.Event("input"));
  document.querySelector<HTMLButtonElement>(".annotation-actions .primary")!.click();
  assert.deepEqual(added, ["> world\n\nChange this"]);
  render(html``, host);
  host.remove();
});

test("selections cannot cross messages and Escape cancels without submitting", () => {
  const host = document.createElement("main");
  document.body.append(host);
  const added: string[] = [];
  render(
    html`<section ${annotate({ key: "messages", selector: "p", add: (text) => added.push(text) })}>
      <p>First message</p>
      <p>Second message</p>
    </section>`,
    host,
  );
  const paragraphs = host.querySelectorAll("p");
  const range = document.createRange();
  range.setStart(paragraphs[0]!.firstChild!, 0);
  range.setEnd(paragraphs[1]!.firstChild!, 4);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  paragraphs[1]!.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  assert.equal(document.querySelector(".annotation-popover"), null);
  range.selectNodeContents(paragraphs[0]!);
  paragraphs[0]!.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  document.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
  assert.equal(document.querySelector<HTMLButtonElement>(".annotation-actions .primary")!.disabled, true);
  const input = document.querySelector<HTMLTextAreaElement>(".annotation-popover textarea")!;
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
  assert.equal(document.querySelector(".annotation-popover"), null);
  assert.deepEqual(added, []);
  render(html``, host);
  host.remove();
});

test("editing survives resize and both cancellation paths restore the draft focus", () => {
  const host = document.createElement("main");
  document.body.append(host);
  render(
    html`<section ${annotate({ key: "focus", selector: ".draft", add: () => assert.fail("unexpected submit") })}>
      <textarea class="draft">Hello world</textarea>
    </section>`,
    host,
  );
  const draft = host.querySelector("textarea")!;
  for (const dismiss of ["escape", "cancel"]) {
    draft.focus();
    draft.setSelectionRange(6, 11);
    draft.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
    const input = document.querySelector<HTMLTextAreaElement>(".annotation-popover textarea")!;
    input.value = "Keep this comment";
    window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(document.querySelector(".annotation-popover textarea"), input);
    assert.equal(input.value, "Keep this comment");
    assert.equal(document.activeElement, input);
    if (dismiss === "escape") {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else document.querySelector<HTMLButtonElement>(".annotation-actions button")!.click();
    assert.equal(document.querySelector(".annotation-popover"), null);
    assert.equal(document.activeElement, draft);
    assert.equal(draft.selectionStart, 6);
    assert.equal(draft.selectionEnd, 11);
  }
  render(html``, host);
  host.remove();
});

test("native host replacement disposes the portal and its global listeners", async () => {
  const container = document.createElement("main");
  document.body.append(container);
  const removed: string[] = [];
  const originalRemove = document.removeEventListener.bind(document);
  document.removeEventListener = ((type: string, ...args: unknown[]) => {
    removed.push(type);
    Reflect.apply(originalRemove, document, [type, ...args]);
  }) as typeof document.removeEventListener;
  try {
    for (let i = 0; i < 3; i++) {
      const host = document.createElement("div");
      container.replaceChildren(host);
      render(html`<section ${annotate({ key: i, selector: "p", add: () => {} })}><p>Passage</p></section>`, host);
      const p = host.querySelector("p")!;
      const range = document.createRange();
      range.selectNodeContents(p);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      p.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
      document.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
      assert.equal(document.querySelector(".annotation-popover")!.parentElement, document.body);
      container.replaceChildren();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      assert.equal(document.querySelector(".annotation-popover"), null);
    }
    for (const type of ["pointerdown", "keydown", "scroll"])
      assert.equal(removed.filter((value) => value === type).length, 3);
  } finally {
    document.removeEventListener = originalRemove;
    container.remove();
  }
});

test("Escape in a nested editor preserves the other unfinished comment", () => {
  const host = document.createElement("main");
  document.body.append(host);
  render(
    html`<section ${annotate({ key: "outer", selector: "p", add: () => {} })}>
      <p>Outer context</p>
      <div ${annotate({ key: "inner", selector: "p", add: () => {} })}><p>Inner chat</p></div>
    </section>`,
    host,
  );
  for (const [index, p] of [...host.querySelectorAll("p")].entries()) {
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    p.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".annotation-popover:not(.editing) button")!.click();
    const input = document.activeElement as HTMLTextAreaElement;
    input.value = `Draft ${index}`;
  }
  document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.querySelectorAll(".annotation-popover").length, 1);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".annotation-popover textarea")!.value, "Draft 0");
  render(html``, host);
  host.remove();
});
