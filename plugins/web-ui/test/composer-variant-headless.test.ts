import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";

installDom('<!doctype html><div id="host"></div>');
const lit = await import("lit");
const { html, render } = lit;
const nothing: typeof lit.nothing = lit.nothing;
const { headless } = await import("../src/composer-variants/headless.ts");

const host = document.getElementById("host")!;
const models = ["gpt-5.6-sol", "opus-5", "open-mistral"].map(
  (id) => ({ value: `pi:${id}`, model: { id } }) as unknown as ModelOption,
);
const calls: string[] = [];
let current: ComposerParts;

function show(draft: string, open: string | null): void {
  current = {
    variant: "headless",
    header: nothing,
    slashMenu: nothing,
    upgradeNotice: nothing,
    attachments: nothing,
    approvals: nothing,
    notice: nothing,
    textarea: html`<textarea class="composer-input"></textarea>`,
    fileInput: html`<input class="file-input" type="file" hidden />`,
    pasteDialog: nothing,
    defaultButtons: nothing,
    sendControls: html``,
    settingsMenu: html``,
    menuControl: () => html``,
    placeholder: "",
    draft,
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit() {},
    pickFiles() {},
    insertText: (text) => void calls.push(`insert:${text}`),
    send: { canSend: true, canQueue: true, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0]!,
      select: (value) => void calls.push(`select:${value}`),
      harnesses: [],
      selectHarness() {},
      supportsFast: () => false,
    },
    effort: { available: false, level: "medium", label: "Medium", levels: [], select() {} },
    fast: { supported: false, available: false, on: false, toggle() {} },
    redraw: () => render(headless.render(current), host),
    queue: { runs: [], steerable: false, remove() {}, steer() {} },
    menu: {
      open,
      toggle() {},
      set: (kind) => void calls.push(`set:${kind}`),
      close: () => void calls.push("close"),
      query: "",
      setQuery() {},
    },
  };
  calls.length = 0;
  render(headless.render(current), host);
}

const textarea = (): HTMLTextAreaElement => host.querySelector("textarea")!;
const wrapper = (): HTMLElement => host.querySelector<HTMLElement>(".headless-field")!;
const options = (): string[] =>
  [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent!.trim());

function key(name: string): { event: KeyboardEvent; reachedTextarea: boolean } {
  let reachedTextarea = false;
  const note = (): void => void (reachedTextarea = true);
  textarea().addEventListener("keydown", note);
  const event = new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  textarea().dispatchEvent(event);
  textarea().removeEventListener("keydown", note);
  return { event, reachedTextarea };
}

test("renders one textarea in a closed combobox wrapper", async () => {
  show("hello", null);
  assert.ok(host.querySelector('form.composer-wrap[data-composer="headless"]'));
  assert.equal(host.querySelectorAll("textarea").length, 1);
  assert.equal(wrapper().getAttribute("role"), "combobox");
  assert.equal(wrapper().getAttribute("aria-expanded"), "false");
  assert.equal(wrapper().hasAttribute("aria-controls"), false);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  assert.equal(key("Enter").reachedTextarea, true);
});

test("a draft ending in an @ query opens the mentions menu once", async () => {
  show("@op", null);
  await Promise.resolve();
  assert.deepEqual(calls, ["set:mentions"]);
  show("@opu", null);
  await Promise.resolve();
  assert.deepEqual(calls, []);
});

test("the open mentions menu lists only matching models as options", () => {
  show("@op", "mentions");
  assert.deepEqual(options(), ["@opus-5", "@open-mistral"]);
  assert.equal(wrapper().getAttribute("role"), "combobox");
  assert.equal(wrapper().getAttribute("aria-expanded"), "true");
  assert.equal(wrapper().getAttribute("aria-controls"), "composer-mentions-menu");
  assert.equal(host.querySelector("#composer-mentions-menu")!.getAttribute("role"), "listbox");
  assert.equal(host.querySelector('[role="option"]')!.getAttribute("aria-selected"), "true");
});

test("ArrowDown then Enter selects the second match before QM's handler sees the keys", () => {
  show("@op", "mentions");
  const down = key("ArrowDown");
  assert.equal(down.event.defaultPrevented, true);
  assert.equal(down.reachedTextarea, false);
  assert.deepEqual(
    [...host.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("aria-selected")),
    ["false", "true"],
  );
  assert.equal(key("Enter").event.defaultPrevented, true);
  assert.deepEqual(calls, ["select:pi:open-mistral", "close"]);
});

test("Escape closes the menu", () => {
  show("@op", "mentions");
  assert.equal(key("Escape").event.defaultPrevented, true);
  assert.deepEqual(calls, ["close"]);
});

test("a draft ending in {{ lists the two variable rows", () => {
  show("Due {{", "mentions");
  assert.deepEqual(options(), ["{{today}}", "{{model}}"]);
  host.querySelector<HTMLButtonElement>('[role="option"]')!.click();
  assert.deepEqual(calls, ["insert:today}} ", "close"]);
});
