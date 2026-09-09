import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";

installDom();
const lit = await import("lit");
const { html, render } = lit;
const nothing: typeof lit.nothing = lit.nothing;
const { perplexity } = await import("../src/composer-variants/perplexity.ts");

function option(value: string, label: string, reasoning: boolean): ModelOption {
  return {
    value,
    label,
    buttonLabel: label,
    harnessId: "pi",
    harnessLabel: "Pi",
    groupLabel: "OpenAI",
    model: { reasoning, input: ["text"] } as ModelOption["model"],
  };
}

const models = [option("pi:sol", "GPT-5.6 Sol", false), option("pi:deep", "Claude Deep", true)];
const efforts: string[] = [];

function parts(overrides: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "perplexity",
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
    placeholder: "Ask anything",
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
      selected: models[0]!,
      select() {},
      harnesses: [{ value: "pi", label: "Pi" }],
      selectHarness() {},
      supportsFast: () => false,
    },
    effort: {
      available: true,
      level: "high",
      label: "High",
      levels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
      select: (level) => void efforts.push(level),
    },
    fast: { supported: false, available: false, on: false, toggle() {} },
    menu: { open: null, toggle() {}, close() {}, query: "", setQuery() {} },
    ...overrides,
  };
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  render(perplexity.render(p), host);
  return host;
}

test("renders the ask box with one textarea and the teal submit", () => {
  const form = mount(parts()).querySelector("form.composer-wrap")!;
  assert.equal(form.getAttribute("data-composer"), "perplexity");
  assert.equal(form.querySelectorAll("textarea.composer-input").length, 1);
  assert.equal(form.querySelectorAll("input.file-input").length, 1);
  const send = form.querySelector<HTMLButtonElement>("button.pplx-send")!;
  assert.equal(send.type, "submit");
  assert.equal(send.disabled, false);
  assert.ok(send.querySelector("svg"));
});

test("the submit greys out until there is something to send", () => {
  const p = parts();
  p.send.canSend = false;
  assert.equal(mount(p).querySelector<HTMLButtonElement>("button.pplx-send")!.disabled, true);
});

test("the mode control mirrors effort: highest is Research, Search selects the lowest level", () => {
  const segments = [...mount(parts()).querySelectorAll<HTMLButtonElement>('.pplx-mode [role="radio"]')];
  assert.deepEqual(
    segments.map((s) => s.textContent!.trim()),
    ["Search", "Research"],
  );
  assert.deepEqual(
    segments.map((s) => s.getAttribute("aria-checked")),
    ["false", "true"],
  );
  efforts.length = 0;
  segments[0]!.click();
  assert.deepEqual(efforts, ["low"]);
});

test("the model popover offers Best and every model", () => {
  const host = mount(parts({ menu: { open: "model", toggle() {}, close() {}, query: "", setQuery() {} } }));
  const menu = host.querySelector("#composer-model-menu")!;
  assert.equal(menu.querySelector(".menu-title")!.textContent!.trim(), "Choose a model");
  assert.deepEqual(
    [...menu.querySelectorAll(".pplx-model-name")].map((n) => n.textContent!.trim()),
    ["Best", "GPT-5.6 Sol", "Claude Deep"],
  );
  assert.equal(menu.querySelector('[aria-checked="true"] .pplx-model-name')!.textContent!.trim(), "GPT-5.6 Sol");
  assert.equal(menu.querySelectorAll(".pplx-pro").length, 1);
});
