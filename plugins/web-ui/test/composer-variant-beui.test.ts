import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "./dom-harness.ts";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";

installDom('<!doctype html><main id="host"></main>');
const lit = await import("lit");
const { html, render } = lit;
const { beui } = await import("../src/composer-variants/beui.ts");

function model(harnessId: string, harnessLabel: string, id: string, label: string): ModelOption {
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    model: { id } as ModelOption["model"],
    label,
    buttonLabel: label,
    groupLabel: harnessLabel,
  };
}

const models = [
  model("pi", "Pi", "sol", "GPT-5.6 Sol"),
  model("pi", "Pi", "luna", "GPT-5.6 Luna"),
  model("opencode", "OpenCode", "vega", "Vega"),
];

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "beui",
    header: lit.nothing,
    slashMenu: lit.nothing,
    upgradeNotice: lit.nothing,
    attachments: lit.nothing,
    approvals: lit.nothing,
    notice: lit.nothing,
    textarea: html`<textarea class="composer-input"></textarea>`,
    fileInput: html`<input class="file-input" type="file" hidden />`,
    pasteDialog: lit.nothing,
    defaultButtons: lit.nothing,
    sendControls: html``,
    settingsMenu: html``,
    menuControl: () => html``,
    placeholder: "",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit() {},
    pickFiles() {},
    insertText() {},
    send: { canSend: true, canQueue: false, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0],
      select() {},
      harnesses: [
        { value: "pi", label: "Pi" },
        { value: "opencode", label: "OpenCode" },
      ],
      selectHarness() {},
      supportsFast: () => false,
    },
    effort: {
      available: true,
      level: "medium",
      label: "Medium",
      levels: [{ value: "medium", label: "Medium" }],
      select() {},
    },
    fast: { supported: true, available: true, on: false, toggle() {} },
    redraw() {},
    queue: { runs: [], steerable: false, remove() {}, steer() {} },
    menu: { open: null, toggle() {}, set() {}, close() {}, query: "", setQuery() {} },
    ...over,
  };
}

const host = document.querySelector<HTMLElement>("#host")!;
const draw = (p: ComposerParts): HTMLElement => {
  render(beui.render(p), host);
  return host.querySelector<HTMLElement>("form.composer-wrap")!;
};
const texts = (root: ParentNode, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((el) => el.textContent!.trim());

test("renders the beui form with one textarea slot", () => {
  const form = draw(parts());
  assert.equal(form.dataset.composer, "beui");
  assert.equal(form.querySelectorAll("textarea").length, 1);
  assert.equal(form.querySelectorAll("input.file-input").length, 1);
});

test("the plus button morphs into the actions popover", () => {
  const closed = draw(parts());
  const plus = closed.querySelector<HTMLButtonElement>(".beui-plus")!;
  assert.equal(plus.getAttribute("aria-expanded"), "false");
  assert.equal(closed.querySelector("#composer-actions-menu"), null);

  const open = draw(parts({ menu: { ...parts().menu, open: "actions" } }));
  assert.equal(open.querySelector(".beui-plus")!.getAttribute("aria-expanded"), "true");
  const popover = open.querySelector('#composer-actions-menu[role="menu"]')!;
  assert.deepEqual(texts(popover, ".beui-action .menu-option-label"), [
    "Add a screenshot or visual reference",
    "Give the agent a specialized workflow",
  ]);
  assert.equal(popover.querySelectorAll(".beui-action .beui-desc").length, 2);
});

test("the model select shows the label and lists both harnesses when open", () => {
  const closed = draw(parts());
  const select = closed.querySelector<HTMLButtonElement>(".beui-select")!;
  assert.equal(select.querySelector(".menu-label")!.textContent, "GPT-5.6 Sol");
  assert.equal(select.querySelector(".beui-mark")!.textContent, "P");

  const open = draw(parts({ menu: { ...parts().menu, open: "model" } }));
  const popover = open.querySelector('#composer-model-menu[role="menu"]')!;
  assert.deepEqual(texts(popover, ".menu-group-label"), ["Pi", "OpenCode"]);
  assert.deepEqual(texts(popover, ".beui-model-row .menu-option-label"), ["GPT-5.6 Sol", "GPT-5.6 Luna", "Vega"]);
  assert.equal(
    popover.querySelector('.beui-model-row[aria-checked="true"] .menu-option-label')!.textContent,
    "GPT-5.6 Sol",
  );
  assert.ok(popover.querySelector('.settings-seg[aria-label="Effort"]'));
  assert.equal(popover.querySelector(".beui-switch-row")!.getAttribute("aria-checked"), "false");
});

test("the send button carries both glyphs and toggles streaming", () => {
  const idle = draw(parts()).querySelector<HTMLButtonElement>(".beui-send")!;
  assert.ok(idle.querySelector(".beui-glyph-send svg"));
  assert.ok(idle.querySelector(".beui-glyph-stop svg"));
  assert.equal(idle.classList.contains("streaming"), false);
  assert.equal(idle.type, "submit");

  const streaming = draw(
    parts({ send: { canSend: false, canQueue: false, streaming: true, stop() {} } }),
  ).querySelector<HTMLButtonElement>(".beui-send")!;
  assert.equal(streaming.classList.contains("streaming"), true);
  assert.equal(streaming.type, "button");
  assert.equal(streaming.disabled, false);
});
