import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";

installDom();
const lit = await import("lit");
const { html, render } = lit;
const nothing: typeof lit.nothing = lit.nothing;
const { cursor } = await import("../src/composer-variants/cursor.ts");

function model(id: string, contextWindow: number): ModelOption {
  return {
    value: `pi:${id}`,
    harnessId: "pi",
    harnessLabel: "Pi",
    label: id,
    buttonLabel: id,
    groupLabel: "OpenAI",
    model: { id, reasoning: contextWindow >= 1_000_000, contextWindow, provider: "openai", input: ["text"] },
  } as unknown as ModelOption;
}

const models = [model("gpt-5.6-sol", 400_000), model("gpt-5.6-pro", 1_000_000)];
const inserted: string[] = [];
const selected: string[] = [];

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "cursor",
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
    placeholder: "Plan, search, build anything",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit() {},
    pickFiles() {},
    insertText: (text) => void inserted.push(text),
    send: { canSend: false, canQueue: false, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0]!,
      select: (value) => void selected.push(value),
      harnesses: [],
      selectHarness() {},
      supportsFast: () => false,
    },
    effort: { available: false, level: "auto", label: "Auto", levels: [], select() {} },
    fast: { supported: false, available: false, on: false, toggle() {} },
    menu: { open: null, toggle() {}, close() {}, query: "", setQuery() {} },
    ...over,
  };
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  render(cursor.render(p), host);
  return host;
}

const openModelMenu = (p: ComposerParts): ComposerParts => ({ ...p, menu: { ...p.menu, open: "model" } });

test("renders the cursor form with a single textarea slot and the file input inside it", () => {
  const host = mount(parts());
  const form = host.querySelector("form.composer-wrap")!;
  assert.equal(form.getAttribute("data-composer"), "cursor");
  assert.equal(host.querySelectorAll("textarea.composer-input").length, 1);
  assert.ok(form.querySelector("input.file-input"));
});

test("the Add context chip inserts an @ into the draft", () => {
  inserted.length = 0;
  const chip = mount(parts()).querySelector<HTMLButtonElement>(".cursor-add-context")!;
  assert.match(chip.textContent!, /Add context/);
  chip.click();
  assert.deepEqual(inserted, ["@"]);
});

test("the mode trigger reads Agent and the model trigger shows the model id in mono", () => {
  const host = mount(parts());
  assert.equal(host.querySelector(".cursor-mode .menu-label")!.textContent!.trim(), "Agent");
  const trigger = host.querySelector(".cursor-model .menu-button")!;
  assert.ok(trigger.classList.contains("cursor-mono"));
  assert.equal(trigger.querySelector(".menu-label")!.textContent!.trim(), "gpt-5.6-sol");
  const css = readFileSync(new URL("../src/styles/composer-cursor.css", import.meta.url), "utf8");
  assert.match(css, /\.cursor-mono \{[^}]*font-family: var\(--font-mono\)/);
});

test("the open model menu has the Auto switch, a search field, both ids and a MAX badge on the 1M model", () => {
  const host = mount(openModelMenu(parts()));
  const menu = host.querySelector("#composer-model-menu")!;
  const auto = menu.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Auto"]')!;
  assert.equal(auto.getAttribute("aria-checked"), "true");
  assert.equal(menu.querySelector("input[type=search]")!.getAttribute("placeholder"), "Search models");
  const ids = [...menu.querySelectorAll(".menu-option .cursor-mono")].map((el) => el.textContent!.trim());
  assert.deepEqual(ids, ["gpt-5.6-sol", "gpt-5.6-pro"]);
  const badges = [...menu.querySelectorAll(".menu-option")].map((row) => Boolean(row.querySelector(".cursor-max")));
  assert.deepEqual(badges, [false, true]);
});

test("Auto is off when another model is selected and turning it on selects the harness's first model", () => {
  selected.length = 0;
  const p = parts();
  const host = mount(openModelMenu({ ...p, models: { ...p.models, selected: models[1]! } }));
  const auto = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(auto.getAttribute("aria-checked"), "false");
  auto.click();
  assert.deepEqual(selected, ["pi:gpt-5.6-sol"]);
});
