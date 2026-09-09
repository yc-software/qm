import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { getBaseModel } from "../src/pi-models.ts";
import { installDom } from "./dom-harness.ts";
import { metadata } from "./model-metadata.ts";

installDom('<!doctype html><main id="host"></main>');
const [lit, { vovk }] = await Promise.all([import("lit"), import("../src/composer-variants/vovk.ts")]);
const { html, render } = lit;

function option(id: string, name: string, harnessId = "pi", harnessLabel = "Pi"): ModelOption {
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    model: getBaseModel(id, metadata(id, name)),
    label: name,
    buttonLabel: name,
    groupLabel: "OpenAI",
  };
}

const sol = option("gpt-5.6-sol", "GPT-5.6 Sol");
const luna = option("gpt-5.6-luna", "GPT-5.6 Luna");
const opus = option("claude-opus", "Claude Opus", "claude", "Claude Code");
const levels = [
  { value: "auto", label: "Auto" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "vovk",
    header: lit.nothing,
    slashMenu: lit.nothing,
    upgradeNotice: lit.nothing,
    attachments: lit.nothing,
    approvals: lit.nothing,
    notice: lit.nothing,
    textarea: html`<textarea class="composer-input" placeholder="Ask anything"></textarea>`,
    fileInput: html`<input class="file-input" type="file" hidden />`,
    pasteDialog: lit.nothing,
    defaultButtons: lit.nothing,
    sendControls: html`<button class="send-btn" type="submit">Send</button>`,
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
    send: { canSend: false, canQueue: false, streaming: false, stop() {} },
    models: {
      all: [sol, luna, opus],
      selected: sol,
      select() {},
      harnesses: [
        { value: "pi", label: "Pi" },
        { value: "claude", label: "Claude Code" },
      ],
      selectHarness() {},
      supportsFast: () => true,
    },
    effort: { available: true, level: "auto", label: "Auto", levels, select() {} },
    fast: { supported: true, available: true, on: false, toggle() {} },
    redraw() {},
    queue: { runs: [], steerable: false, remove() {}, steer() {} },
    menu: { open: null, toggle() {}, set() {}, close() {}, query: "", setQuery() {} },
    ...over,
  };
}

const host = document.querySelector<HTMLElement>("#host")!;
const draw = (over: Partial<ComposerParts> = {}): HTMLElement => {
  render(vovk.render(parts(over)), host);
  return host;
};

test("renders the vovk form with a single textarea slot", () => {
  const el = draw();
  assert.equal(el.querySelector("form.composer-wrap")!.getAttribute("data-composer"), "vovk");
  assert.equal(el.querySelectorAll("textarea").length, 1);
  assert.ok(el.querySelector('form input[type="file"]'));
});

test("the floating toolbar carries attach, skills, and the model chip with label and context window", () => {
  const el = draw();
  const bar = el.querySelector<HTMLElement>('.vovk-bar[role="toolbar"]')!;
  assert.ok(bar.querySelector('[aria-label="Attach files"]'));
  assert.ok(bar.querySelector('[aria-label="Skills"]'));
  const chip = bar.querySelector<HTMLElement>(".vovk-chip")!;
  assert.equal(chip.querySelector(".vovk-mark")!.textContent, "P");
  assert.equal(chip.querySelector(".menu-label")!.textContent, "GPT-5.6 Sol");
  assert.equal(chip.querySelector(".vovk-ctx")!.textContent, "99K");
});

test("the rotating hint renders only while the draft is empty", () => {
  const empty = draw();
  const hints = [...empty.querySelectorAll(".vovk-hint span")].map((s) => s.textContent);
  assert.deepEqual(hints, ["Ask anything…", "Draft a plan for…", "Explain this code…"]);
  assert.ok(empty.querySelector(".vovk-field.hinting"));
  const typed = draw({ draft: "hello" });
  assert.equal(typed.querySelector(".vovk-hint"), null);
  assert.equal(typed.querySelector(".vovk-field.hinting"), null);
});

test("the open model menu expands the selected row with fast and thinking switches", () => {
  const menu = { open: "model", toggle() {}, set() {}, close() {}, query: "", setQuery() {} };
  let el = draw({ menu, fast: { supported: true, available: true, on: true, toggle() {} } });
  const popover = el.querySelector<HTMLElement>('#composer-model-menu[role="menu"]')!;
  assert.ok(popover);
  const groups = [...popover.querySelectorAll(".menu-group-label")].map((g) => g.textContent);
  assert.deepEqual(groups, ["Pi", "Claude Code"]);
  const active = popover.querySelectorAll(".vovk-model-row.active");
  assert.equal(active.length, 1);
  assert.equal(active[0]!.querySelector(".vovk-model-name")!.textContent, "GPT-5.6 Sol");
  assert.ok(active[0]!.querySelector(".vovk-model-settings"));
  assert.equal(popover.querySelectorAll(".vovk-model-settings").length, 1);
  assert.equal(popover.querySelector('[role="switch"][aria-label="Fast mode"]')!.getAttribute("aria-checked"), "true");
  assert.equal(popover.querySelector('[role="switch"][aria-label="Thinking"]')!.getAttribute("aria-checked"), "false");
  assert.equal(popover.querySelectorAll('[role="group"][aria-label="Effort"] .settings-chip').length, 3);

  el = draw({ menu, effort: { available: true, level: "high", label: "High", levels, select() {} } });
  assert.equal(el.querySelector('[role="switch"][aria-label="Thinking"]')!.getAttribute("aria-checked"), "true");
  assert.equal(el.querySelector('[role="switch"][aria-label="Fast mode"]')!.getAttribute("aria-checked"), "false");

  el = draw({ menu, fast: { supported: false, available: false, on: false, toggle() {} } });
  assert.ok(el.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Fast mode"]')!.disabled);
});

test("the status indicator reads Working… while streaming and Ready otherwise", () => {
  const idle = draw().querySelector<HTMLElement>(".vovk-status")!;
  assert.equal(idle.dataset.state, "ready");
  assert.equal(idle.textContent!.trim(), "Ready");
  const busy = draw({
    send: { canSend: false, canQueue: true, streaming: true, stop() {} },
  }).querySelector<HTMLElement>(".vovk-status")!;
  assert.equal(busy.dataset.state, "working");
  assert.equal(busy.textContent!.trim(), "Working…");
  assert.equal(busy.parentElement!.querySelector(".vovk-hint"), null);
});
