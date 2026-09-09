import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "./dom-harness.ts";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";

installDom();
const lit = (await import("lit")) as typeof import("lit");
const { dqnamo } = await import("../src/composer-variants/dqnamo.ts");

function option(
  id: string,
  label: string,
  provider: string,
  model: { reasoning: boolean; input: string[]; contextWindow: number; cost: number },
): ModelOption {
  return {
    value: `pi:${id}`,
    harnessId: "pi",
    harnessLabel: "Pi",
    label,
    buttonLabel: label,
    groupLabel: provider,
    model: {
      id,
      provider: provider.toLowerCase(),
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      cost: { input: model.cost, output: model.cost * 4 },
    },
  } as unknown as ModelOption;
}

const sol = option("gpt-5.6-sol", "GPT-5.6 Sol", "OpenAI", {
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 400_000,
  cost: 1.25,
});
const opus = option("claude-opus", "Claude Opus", "Anthropic", {
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  cost: 15,
});
const flash = option("gemini-flash", "Gemini Flash", "Google", {
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  cost: 0.1,
});

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  const noop = () => {};
  return {
    variant: "dqnamo",
    header: lit.nothing,
    slashMenu: lit.nothing,
    upgradeNotice: lit.nothing,
    attachments: lit.nothing,
    approvals: lit.nothing,
    notice: lit.nothing,
    textarea: lit.html`<textarea class="composer-input"></textarea>`,
    fileInput: lit.html`<input class="file-input" type="file" hidden />`,
    pasteDialog: lit.nothing,
    defaultButtons: lit.nothing,
    sendControls: lit.html`<button class="send-btn"></button>`,
    settingsMenu: lit.html`<div class="settings-control"></div>`,
    menuControl: () => lit.html``,
    placeholder: "Ask anything",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit: noop,
    pickFiles: noop,
    insertText: noop,
    send: { canSend: true, canQueue: false, streaming: false, stop: noop },
    models: {
      all: [sol, opus, flash],
      selected: sol,
      select: noop,
      harnesses: [{ value: "pi", label: "Pi" }],
      selectHarness: noop,
      supportsFast: (id) => id === sol.model.id,
    },
    effort: { available: false, level: "auto", label: "Auto", levels: [], select: noop },
    fast: { supported: false, available: false, on: false, toggle: noop },
    redraw: noop,
    queue: { runs: [], steerable: false, remove: noop, steer: noop },
    menu: { open: null, toggle: noop, set: noop, close: noop, query: "", setQuery: noop },
    ...over,
  };
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  p.redraw = () => lit.render(dqnamo.render(p), host);
  p.redraw();
  return host;
}

function openPicker(over: Partial<ComposerParts> = {}): { p: ComposerParts; host: HTMLElement } {
  mount(parts());
  const p = parts(over);
  p.menu.open = "model";
  return { p, host: mount(p) };
}

test("the composer renders one textarea, the labelled send button and the combobox trigger", () => {
  const host = mount(parts());
  const form = host.querySelector("form.composer-wrap")!;
  assert.equal(form.getAttribute("data-composer"), "dqnamo");
  assert.equal(host.querySelectorAll("textarea.composer-input").length, 1);
  assert.ok(form.querySelector("input.file-input"));
  const send = form.querySelector<HTMLButtonElement>(".dq-send")!;
  assert.equal(send.type, "submit");
  assert.equal(send.textContent!.trim(), "Send");
  assert.ok(send.querySelector("svg"));
  const trigger = form.querySelector(".dq-trigger")!;
  assert.equal(trigger.getAttribute("role"), "combobox");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.querySelector(".dq-trigger-label")!.textContent!.trim(), "GPT-5.6 Sol");
  assert.equal(trigger.querySelector(".dq-mark")!.textContent!.trim(), "O");
  assert.equal(form.querySelector(".menu-popover"), null);
});

test("streaming swaps the send button for a labelled stop", () => {
  let stopped = 0;
  const host = mount(parts({ send: { canSend: true, canQueue: true, streaming: true, stop: () => stopped++ } }));
  const stop = host.querySelector<HTMLButtonElement>(".dq-send.dq-stop")!;
  assert.equal(stop.type, "button");
  assert.equal(stop.textContent!.trim(), "Stop");
  stop.click();
  assert.equal(stopped, 1);
});

test("the open picker renders a searchbox wired to a listbox of options with badges", () => {
  const { host } = openPicker();
  assert.equal(host.querySelector(".dq-trigger")!.getAttribute("aria-expanded"), "true");
  const search = host.querySelector<HTMLInputElement>('[role="searchbox"]')!;
  const list = host.querySelector('[role="listbox"]')!;
  assert.equal(search.getAttribute("aria-controls"), list.id);
  const rows = [...list.querySelectorAll('[role="option"]')];
  assert.deepEqual(
    rows.map((r) => r.querySelector(".dq-row-name")!.textContent!.trim()),
    ["GPT-5.6 Sol", "Claude Opus", "Gemini Flash"],
  );
  assert.deepEqual(
    rows.map((r) => r.getAttribute("aria-selected")),
    ["true", "false", "false"],
  );
  const badges = (row: Element) => [...row.querySelectorAll(".dq-badge")].map((b) => b.textContent!.trim());
  assert.deepEqual(badges(rows[0]!), ["Vision"]);
  assert.deepEqual(badges(rows[1]!), ["Vision", "Reasoning", "1M"]);
  assert.deepEqual(badges(rows[2]!), []);
  assert.equal(list.querySelector(".dq-group-label")!.textContent!.trim(), "Pi");
});

test("the preview card scores the selected model and offers no redundant select", () => {
  const { host } = openPicker();
  const card = host.querySelector(".dq-preview")!;
  assert.equal(card.querySelector(".dq-preview-name")!.textContent!.trim(), "GPT-5.6 Sol");
  assert.equal(card.querySelector(".dq-preview-provider")!.textContent!.trim(), "OpenAI · Pi");
  assert.deepEqual(
    [...card.querySelectorAll("dt")].map((el) => el.textContent!.trim()),
    ["Intelligence", "Speed", "Context", "Cost"],
  );
  assert.deepEqual(
    [...card.querySelectorAll<HTMLElement>(".dq-bar-fill")].map((el) => el.style.width),
    ["62%", "90%", "20%", "94%"],
  );
  assert.deepEqual(
    [...card.querySelectorAll(".dq-metric-value")].map((el) => el.textContent!.trim()),
    ["62", "90", "400K", "$1.25/M in"],
  );
  assert.equal(card.querySelector<HTMLButtonElement>(".dq-select")!.disabled, true);
});

test("hovering another option switches the preview after a redraw", () => {
  const picked: string[] = [];
  const { p, host } = openPicker();
  p.models.select = (value) => picked.push(value);
  const rows = host.querySelectorAll<HTMLElement>('[role="option"]');
  rows[1]!.dispatchEvent(new window.MouseEvent("mouseenter"));
  const card = host.querySelector(".dq-preview")!;
  assert.equal(card.querySelector(".dq-preview-name")!.textContent!.trim(), "Claude Opus");
  assert.deepEqual(
    [...card.querySelectorAll<HTMLElement>(".dq-bar-fill")].map((el) => el.style.width),
    ["92%", "55%", "50%", "25%"],
  );
  assert.deepEqual(
    [...card.querySelectorAll(".dq-metric-value")].map((el) => el.textContent!.trim()),
    ["92", "55", "1M", "$15/M in"],
  );
  const select = card.querySelector<HTMLButtonElement>(".dq-select")!;
  assert.equal(select.disabled, false);
  select.click();
  assert.deepEqual(picked, ["pi:claude-opus"]);
});

test("arrow keys walk the list, Enter selects the active option and Escape closes", () => {
  const picked: string[] = [];
  let closed = 0;
  const { p, host } = openPicker();
  p.models.select = (value) => picked.push(value);
  p.menu.close = () => closed++;
  const search = host.querySelector<HTMLInputElement>('[role="searchbox"]')!;
  const key = (name: string) =>
    search.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  key("ArrowUp");
  assert.equal(host.querySelector("[data-active] .dq-row-name")!.textContent!.trim(), "Gemini Flash");
  assert.equal(host.querySelector(".dq-preview-name")!.textContent!.trim(), "Gemini Flash");
  key("ArrowDown");
  key("ArrowDown");
  const active = host.querySelector("[data-active]")!;
  assert.equal(active.querySelector(".dq-row-name")!.textContent!.trim(), "Claude Opus");
  assert.equal(search.getAttribute("aria-activedescendant"), active.id);
  key("Enter");
  assert.deepEqual(picked, ["pi:claude-opus"]);
  key("Escape");
  assert.equal(closed, 1);
});

test("the query filters the list and an empty match keeps the preview on the selection", () => {
  const { host } = openPicker({
    menu: { open: "model", toggle() {}, set() {}, close() {}, query: "gem", setQuery() {} },
  });
  const names = [...host.querySelectorAll(".dq-row-name")].map((el) => el.textContent!.trim());
  assert.deepEqual(names, ["Gemini Flash"]);
  assert.equal(host.querySelector(".dq-preview-name")!.textContent!.trim(), "GPT-5.6 Sol");
  const none = openPicker({ menu: { open: "model", toggle() {}, set() {}, close() {}, query: "zzz", setQuery() {} } });
  assert.equal(none.host.querySelectorAll('[role="option"]').length, 0);
  assert.ok(none.host.querySelector(".menu-empty"));
});
