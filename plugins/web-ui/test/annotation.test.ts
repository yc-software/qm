import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
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
  host.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
  const input = host.querySelector("textarea")!;
  input.value = "Explain this";
  input.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(added, []);
  host.querySelector<HTMLButtonElement>(".annotation-actions .primary")!.click();
  assert.deepEqual(added, ["> Selected passage\n\nExplain this"]);
  assert.equal(host.querySelector(".annotation-popover"), null);
  select();
  draw("second");
  assert.equal(host.querySelector(".annotation-popover"), null);
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
  host.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
  const comment = host.querySelector<HTMLTextAreaElement>(".annotation-popover textarea")!;
  comment.value = "Change this";
  comment.dispatchEvent(new dom.window.Event("input"));
  host.querySelector<HTMLButtonElement>(".annotation-actions .primary")!.click();
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
  assert.equal(host.querySelector(".annotation-popover"), null);
  range.selectNodeContents(paragraphs[0]!);
  paragraphs[0]!.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  host.querySelector<HTMLButtonElement>(".annotation-popover button")!.click();
  assert.equal(host.querySelector<HTMLButtonElement>(".annotation-actions .primary")!.disabled, true);
  const input = host.querySelector("textarea")!;
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
  assert.equal(host.querySelector(".annotation-popover"), null);
  assert.deepEqual(added, []);
  render(html``, host);
  host.remove();
});
