import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { getBaseModel } from "../src/pi-models.ts";
import { installDom } from "./dom-harness.ts";
import { metadata } from "./model-metadata.ts";

installDom('<!doctype html><div id="form"></div><div id="topbar"></div>');
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
const { chatgpt } = (await vite.ssrLoadModule(
  "/src/composer-variants/chatgpt.ts",
)) as typeof import("../src/composer-variants/chatgpt.ts");
const lit = (await vite.ssrLoadModule("lit")) as typeof import("lit");
const { html, render } = lit;
await vite.close();

function option(id: string, name: string, harnessId: string, harnessLabel: string, reasoning: boolean): ModelOption {
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    model: { ...getBaseModel(id, metadata(id, name)), reasoning },
    label: name,
    buttonLabel: name,
    groupLabel: "OpenAI",
  };
}

const gpt = option("gpt-5", "GPT-5", "pi", "Pi", false);
const thinking = option("o3", "o3", "pi", "Pi", true);
const codex = option("gpt-5", "GPT-5 (Codex)", "codex", "Codex", false);

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "chatgpt",
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
    pickFiles() {},
    insertText() {},
    send: { canSend: true, canQueue: false, streaming: false, stop() {} },
    models: {
      all: [gpt, thinking, codex],
      selected: gpt,
      select() {},
      harnesses: [{ value: "pi", label: "Pi" }],
      selectHarness() {},
      supportsFast: () => false,
    },
    effort: {
      available: true,
      level: "medium",
      label: "Medium",
      levels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
      ],
      select() {},
    },
    fast: { supported: false, available: false, on: false, toggle() {} },
    menu: { open: null, toggle() {}, close() {}, query: "", setQuery() {} },
    ...over,
  };
}

const formHost = document.querySelector<HTMLElement>("#form")!;
const topbarHost = document.querySelector<HTMLElement>("#topbar")!;

test("the bar is a single pill with the plus, the textarea once, and a send circle", () => {
  render(chatgpt.render(parts()), formHost);
  const form = formHost.querySelector("form")!;
  assert.equal(form.dataset.composer, "chatgpt");
  assert.equal(form.querySelectorAll("textarea.composer-input").length, 1);
  assert.ok(form.querySelector(".chatgpt-row > .menu-control .chatgpt-plus"));
  assert.ok(form.querySelector("input.file-input"));
  assert.ok(form.querySelector("button.send-btn[type=submit]"));
  assert.equal(form.querySelector(".model-control"), null);
  assert.equal(form.querySelector(".menu-popover"), null);
});

test("streaming swaps the send circle for a stop circle", () => {
  render(chatgpt.render(parts({ send: { canSend: false, canQueue: true, streaming: true, stop() {} } })), formHost);
  assert.equal(formHost.querySelector(".send-btn"), null);
  assert.ok(formHost.querySelector(".chatgpt-row > .stop-btn"));
});

test("the plus opens an actions popover whose rows pick files or start a skill", () => {
  const calls: string[] = [];
  const p = parts({
    pickFiles: () => void calls.push("pick"),
    insertText: (text) => void calls.push(`insert:${text}`),
    menu: { open: "actions", toggle() {}, close: () => void calls.push("close"), query: "", setQuery() {} },
  });
  render(chatgpt.render(p), formHost);
  const popover = formHost.querySelector<HTMLElement>("#composer-actions-menu[role=menu]")!;
  const rows = [...popover.querySelectorAll<HTMLButtonElement>(".menu-option")];
  assert.deepEqual(
    rows.map((row) => row.textContent!.trim()),
    ["Add photos & files", "Use a skill"],
  );
  rows[0]!.click();
  rows[1]!.click();
  assert.deepEqual(calls, ["close", "pick", "close", "insert:/"]);
});

test("the topbar trigger names the selected model and drops the picker down", () => {
  render(chatgpt.topbar!(parts()), topbarHost);
  const control = topbarHost.querySelector<HTMLElement>(".menu-control")!;
  assert.equal(control.dataset.drop, "down");
  assert.equal(control.querySelector(".menu-button .menu-label")!.textContent, "GPT-5");
  assert.equal(control.querySelector(".menu-popover"), null);
});

test("the open picker lists the harness's models with descriptions, folds the rest, and offers effort pills", () => {
  const selected: string[] = [];
  const p = parts({ menu: { open: "picker", toggle() {}, close() {}, query: "", setQuery() {} } });
  p.models.select = (value) => void selected.push(value);
  p.effort.select = (level) => void selected.push(`effort:${level}`);
  render(chatgpt.topbar!(p), topbarHost);
  const popover = topbarHost.querySelector<HTMLElement>("#composer-picker-menu[role=menu]")!;
  const labels = [...popover.querySelectorAll(".menu-option-label")].map((el) => el.textContent);
  assert.deepEqual(labels, ["GPT-5", "o3", "GPT-5 (Codex)"]);
  const descriptions = [...popover.querySelectorAll(".menu-option-desc")].map((el) => el.textContent);
  assert.deepEqual(descriptions, ["Great for most tasks", "Great for complex reasoning", "Great for most tasks"]);
  assert.ok(popover.querySelector(".menu-option.active .menu-option-label")!.textContent === "GPT-5");
  assert.ok(popover.querySelector(".menu-option.active svg"));
  const more = popover.querySelector<HTMLDetailsElement>("details.chatgpt-more")!;
  assert.equal(more.querySelector("summary")!.textContent!.trim(), "More models");
  assert.equal(more.querySelector(".menu-group-label")!.textContent, "Codex");
  assert.ok(more.contains(popover.querySelectorAll(".menu-option-label")[2]!));
  const pills = [...popover.querySelectorAll<HTMLButtonElement>(".chatgpt-pill")];
  assert.deepEqual(
    pills.map((pill) => [pill.textContent!.trim(), pill.getAttribute("aria-pressed")]),
    [
      ["Low", "false"],
      ["Medium", "true"],
    ],
  );
  popover.querySelectorAll<HTMLButtonElement>(".menu-option[role=menuitemradio]")[1]!.click();
  pills[0]!.click();
  assert.deepEqual(selected, ["pi:o3", "effort:low"]);
});
