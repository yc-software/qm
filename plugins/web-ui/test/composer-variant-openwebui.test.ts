import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";

installDom('<!doctype html><div id="composer"></div><div id="topbar"></div>');
const lit = await import("lit");
const { html, render } = lit;
const { openwebui } = await import("../src/composer-variants/openwebui.ts");

function model(harnessId: string, harnessLabel: string, id: string, label: string, reasoning = false): ModelOption {
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    label,
    buttonLabel: label,
    groupLabel: harnessLabel,
    model: { id, reasoning } as ModelOption["model"],
  };
}

const models = [
  model("pi", "Pi", "sol", "GPT-5.6 Sol", true),
  model("pi", "Pi", "luna", "Luna"),
  model("claude", "Claude Code", "fable", "Fable 5.1"),
];

function fakeParts(): ComposerParts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    variant: "openwebui",
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
    placeholder: "Ask anything",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit() {},
    pickFiles: () => void calls.push("pickFiles"),
    insertText: (text) => void calls.push(`insert:${text}`),
    send: { canSend: false, canQueue: false, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0]!,
      select: (value) => void calls.push(`select:${value}`),
      harnesses: [
        { value: "pi", label: "Pi" },
        { value: "claude", label: "Claude Code" },
      ],
      selectHarness() {},
      supportsFast: (id) => id === "luna",
    },
    effort: { available: false, level: "medium", label: "Medium", levels: [], select() {} },
    fast: { supported: false, available: false, on: false, toggle() {} },
    redraw() {},
    queue: { runs: [], steerable: false, remove() {}, steer() {} },
    menu: {
      open: null,
      toggle() {},
      set: (kind) => void calls.push(`set:${kind}`),
      close: () => void calls.push("close"),
      query: "",
      setQuery() {},
    },
  };
}

const host = document.querySelector<HTMLElement>("#composer")!;
const topbarHost = document.querySelector<HTMLElement>("#topbar")!;
const draw = (p: ComposerParts): void => {
  render(openwebui.render(p), host);
};
const texts = (selector: string): string[] => [...host.querySelectorAll(selector)].map((el) => el.textContent!.trim());

test("the form carries the variant id and renders the textarea and file input once", () => {
  draw(fakeParts());
  const form = host.querySelector<HTMLFormElement>('form[data-composer="openwebui"]')!;
  assert.ok(form);
  assert.equal(host.querySelectorAll("textarea").length, 1);
  assert.equal(form.querySelectorAll("input.file-input").length, 1);
  assert.equal(form.querySelector(".owui-mic")!.getAttribute("aria-disabled"), "true");
  assert.ok(form.querySelector(".send-btn"));
});

test("the header trigger shows the selected model label", () => {
  render(openwebui.topbar!(fakeParts()), topbarHost);
  const trigger = topbarHost.querySelector<HTMLButtonElement>(".owui-picker-btn")!;
  assert.equal(trigger.querySelector(".owui-picker-label")!.textContent, "GPT-5.6 Sol");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(topbarHost.querySelector("#composer-picker-menu"), null);
});

test("the model popover has a search field, the selected harness first, and every harness under a heading", () => {
  const p = fakeParts();
  p.menu.open = "model";
  draw(p);
  const menu = host.querySelector<HTMLElement>("#composer-model-menu")!;
  assert.ok(menu.querySelector('input[type="search"]'));
  assert.deepEqual(texts("#composer-model-menu .menu-group-label"), ["Pi", "Claude Code"]);
  assert.deepEqual(texts("#composer-model-menu .owui-desc"), ["Reasoning model", "Fast responses", "General model"]);
  const checked = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')!;
  assert.equal(checked.querySelector(".menu-option-label")!.textContent, "GPT-5.6 Sol");
  checked.nextElementSibling!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(p.calls, ["select:pi:luna"]);
});

test("a draft ending in @ opens the mentions popover once", async () => {
  const p = fakeParts();
  p.draft = "hello @";
  draw(p);
  await Promise.resolve();
  assert.deepEqual(p.calls, ["set:mentions"]);
  draw(p);
  await Promise.resolve();
  assert.deepEqual(p.calls, ["set:mentions"]);
  p.menu.open = "mentions";
  draw(p);
  assert.deepEqual(texts("#composer-mentions-menu .menu-group-label"), ["Attach", "Models"]);
  host.querySelector<HTMLButtonElement>("#composer-mentions-menu .menu-option")!.click();
  assert.deepEqual(p.calls, ["set:mentions", "close", "pickFiles"]);
});

test("a draft starting with /model opens the model popover once until the command is gone", async () => {
  const p = fakeParts();
  p.draft = "/Model";
  draw(p);
  await Promise.resolve();
  assert.deepEqual(p.calls, ["set:model"]);
  draw(p);
  await Promise.resolve();
  assert.deepEqual(p.calls, ["set:model"]);
  p.draft = "";
  draw(p);
  p.draft = "/model";
  draw(p);
  await Promise.resolve();
  assert.deepEqual(p.calls, ["set:model", "set:model"]);
});
