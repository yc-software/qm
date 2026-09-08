import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { markClampedPrompts } from "../src/prompt-clamp.ts";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

const pinned = String.raw`\.message-stack \.user-row:not\(:has\(~ \.user-row\)\) \.user-bubble`;

function bubbleDom(scrollHeight: number, clientHeight: number, expanded = "false"): HTMLElement {
  const dom = new JSDOM(`<div class="message-stack">
    <article class="message-row user-row">
      <div class="message-bubble user-bubble" data-expanded="${expanded}">
        <markdown-block></markdown-block>
      </div>
    </article>
  </div>`);
  const body = dom.window.document.querySelector("markdown-block")!;
  Object.defineProperty(body, "scrollHeight", { value: scrollHeight });
  Object.defineProperty(body, "clientHeight", { value: clientHeight });
  markClampedPrompts(dom.window.document);
  return dom.window.document.querySelector<HTMLElement>(".user-bubble")!;
}

test("a prompt taller than its cap is marked clamped; one that fits is not", () => {
  assert.equal(bubbleDom(800, 240).dataset.clamped, "true");
  assert.equal(bubbleDom(240, 240).dataset.clamped, "false");
});

test("an expanded prompt keeps its clamped mark so Show less stays reachable", () => {
  const dom = new JSDOM(`<div class="message-stack">
    <article class="message-row user-row">
      <div class="message-bubble user-bubble" data-clamped="true" data-expanded="true">
        <markdown-block></markdown-block>
      </div>
    </article>
  </div>`);
  const body = dom.window.document.querySelector("markdown-block")!;
  Object.defineProperty(body, "scrollHeight", { value: 800 });
  Object.defineProperty(body, "clientHeight", { value: 800 });
  markClampedPrompts(dom.window.document);
  assert.equal(dom.window.document.querySelector<HTMLElement>(".user-bubble")!.dataset.clamped, "true");
});

test("only the last user row is measured — earlier prompts are never clamped", () => {
  const dom = new JSDOM(`<div class="message-stack">
    <article class="message-row user-row"><div class="user-bubble"><markdown-block></markdown-block></div></article>
    <article class="message-row user-row"><div class="user-bubble"><markdown-block></markdown-block></div></article>
  </div>`);
  for (const body of dom.window.document.querySelectorAll("markdown-block")) {
    Object.defineProperty(body, "scrollHeight", { value: 800 });
    Object.defineProperty(body, "clientHeight", { value: 240 });
  }
  markClampedPrompts(dom.window.document);
  const bubbles = dom.window.document.querySelectorAll<HTMLElement>(".user-bubble");
  assert.equal(bubbles[0].dataset.clamped, undefined);
  assert.equal(bubbles[1].dataset.clamped, "true");
});

test("the clamped prompt clips instead of scrolling, and expanding lifts the cap", () => {
  const text =
    css.match(new RegExp(String.raw`\n${pinned} > markdown-block,\n${pinned} > \.slack-wire-text \{[^}]*\}`))?.[0] ??
    "";
  assert.match(text, /overflow: hidden;/);
  assert.doesNotMatch(text, /overflow-y: auto;/);
  assert.match(css, new RegExp(String.raw`\n${pinned}\[data-expanded="true"\] \{[^}]*max-height: none;`));
});

test("the toggle is hidden until the prompt actually overflows", () => {
  const base = css.match(/\n\.prompt-toggle \{[^}]*\}/)?.[0] ?? "";
  assert.match(base, /display: none;/);
  assert.match(
    css,
    new RegExp(
      String.raw`${pinned}\[data-clamped="true"\] > \.prompt-toggle,\n${pinned}\[data-expanded="true"\] > \.prompt-toggle \{\s*display: block;`,
    ),
  );
});

test("the toggle names its own next action and reports state to assistive tech", () => {
  assert.match(chat, /chatState\.expandedPrompt === index \? "Show less" : "Show more"/);
  assert.match(chat, /aria-expanded=\$\{chatState\.expandedPrompt === index \? "true" : "false"\}/);
  assert.match(chat, /@click=\$\{\(\) => togglePromptExpanded\(index\)\}/);
});

test("toggling a prompt redraws through whichever surface is mounted", () => {
  const fn = chat.match(/function togglePromptExpanded\(index: number\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(fn, /chatState\.expandedPrompt = chatState\.expandedPrompt === index \? null : index;/);
  assert.match(fn, /if \(chatState\.agent\) drawActiveChat\(chatState\.agent\);\s*else readonlyRedraw\?\.\(\);/);
});

test("both transcript surfaces re-measure after every render", () => {
  assert.equal(chat.match(/markClampedPrompts\((host|chatState\.host)\)/g)?.length, 2);
});

test("switching sessions collapses the prompt again — the index never carries over", () => {
  assert.equal(chat.match(/chatState\.expandedPrompt = null;/g)?.length, 2);
});
