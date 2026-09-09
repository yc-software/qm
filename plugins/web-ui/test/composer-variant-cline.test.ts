import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts, Tpl } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";
import { metadata } from "./model-metadata.ts";

installDom();
const lit = await import("lit");
const { html, render } = lit;
const empty: Tpl = lit.nothing;
const { cline } = await import("../src/composer-variants/cline.ts");
const { getBaseModel } = await import("../src/pi-models.ts");

function option(harnessId: string, harnessLabel: string, id: string, name: string, reasoning = false): ModelOption {
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    model: getBaseModel(id, { ...metadata(id, name), reasoning }),
    label: name,
    buttonLabel: name,
    groupLabel: "OpenAI",
  };
}

const sol = option("pi", "Pi", "gpt-sol", "GPT Sol");
const deep = option("pi", "Pi", "o-deep", "O Deep", true);
const opus = option("claude", "Claude Code", "opus", "Opus");
const levels = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const noop = (): void => {};

function parts(
  over: { level?: string; open?: string | null; selectEffort?: (level: string) => void } = {},
): ComposerParts {
  return {
    variant: "cline",
    header: empty,
    slashMenu: empty,
    upgradeNotice: empty,
    attachments: empty,
    approvals: empty,
    notice: empty,
    textarea: html`<textarea class="composer-input"></textarea>`,
    fileInput: html`<input class="file-input" type="file" hidden />`,
    pasteDialog: empty,
    defaultButtons: empty,
    sendControls: html``,
    settingsMenu: html``,
    menuControl: () => html``,
    placeholder: "Ask Cline",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit: noop,
    pickFiles: noop,
    insertText: noop,
    send: { canSend: true, canQueue: false, streaming: false, stop: noop },
    models: {
      all: [sol, deep, opus],
      selected: deep,
      select: noop,
      harnesses: [
        { value: "pi", label: "Pi" },
        { value: "claude", label: "Claude Code" },
      ],
      selectHarness: noop,
      supportsFast: () => false,
    },
    effort: { available: true, level: over.level ?? "high", label: "High", levels, select: over.selectEffort ?? noop },
    fast: { supported: false, available: false, on: false, toggle: noop },
    redraw: noop,
    queue: { runs: [], steerable: false, remove: noop, steer: noop },
    menu: { open: over.open ?? null, toggle: noop, set: noop, close: noop, query: "", setQuery: noop },
  };
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  render(cline.render(p), host);
  return host;
}

const texts = (host: HTMLElement, selector: string): string[] =>
  [...host.querySelectorAll(selector)].map((el) => el.textContent!.trim());

test("renders the cline form with a single textarea slot", () => {
  const host = mount(parts());
  assert.ok(host.querySelector('form.composer-wrap[data-composer="cline"]'));
  assert.equal(host.querySelectorAll("textarea").length, 1);
  assert.ok(host.querySelector('input[type="file"]'));
  assert.equal(host.querySelector("#composer-model-menu"), null);
});

test("Plan and Act mirror the effort level and select the lowest and highest levels", () => {
  const selected: string[] = [];
  const host = mount(parts({ level: "high", selectEffort: (level) => void selected.push(level) }));
  const [plan, act] = [...host.querySelectorAll<HTMLButtonElement>(".cline-seg")];
  assert.equal(plan!.textContent!.trim(), "Plan");
  assert.equal(plan!.getAttribute("aria-pressed"), "false");
  assert.equal(act!.getAttribute("aria-pressed"), "true");
  plan!.click();
  assert.deepEqual(selected, ["low"]);
  const low = mount(parts({ level: "low" }));
  assert.equal(low.querySelector(".cline-seg")!.getAttribute("aria-pressed"), "true");
});

test("the model trigger shows the button label with a Recommended tag for a reasoning model", () => {
  const host = mount(parts());
  const trigger = host.querySelector(".menu-button")!;
  assert.equal(trigger.querySelector(".menu-label")!.textContent, "O Deep");
  assert.equal(trigger.querySelector(".cline-tier")!.textContent, "Recommended");
});

test("the open model menu lists Recommended reasoning models with descriptions and all models by harness", () => {
  const host = mount(parts({ open: "model" }));
  const menu = host.querySelector<HTMLElement>('#composer-model-menu[role="menu"]')!;
  assert.deepEqual(texts(menu, ".menu-title"), ["Recommended", "All models"]);
  const pick = menu.querySelector(".cline-pick")!;
  assert.equal(pick.querySelector(".menu-option-label")!.textContent, "O Deep");
  assert.equal(pick.querySelector(".cline-pick-desc")!.textContent, "Best for complex, multi-step work");
  assert.equal(menu.querySelectorAll(".cline-pick").length, 1);
  assert.deepEqual(texts(menu, ".menu-group-label"), ["Pi", "Claude Code"]);
  assert.deepEqual(texts(menu, ".menu-option:not(.cline-pick) .menu-option-label"), ["GPT Sol", "O Deep", "Opus"]);
  assert.ok(menu.querySelector('input[type="search"]'));
});
