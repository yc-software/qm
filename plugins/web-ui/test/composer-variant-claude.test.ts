import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "./dom-harness.ts";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";

installDom();
const lit = (await import("lit")) as typeof import("lit");
const { claude } = await import("../src/composer-variants/claude.ts");

function option(id: string, label: string, reasoning: boolean): ModelOption {
  return {
    value: id,
    harnessId: "pi",
    harnessLabel: "Pi",
    label,
    buttonLabel: label,
    groupLabel: "Anthropic",
    model: { id, reasoning, input: ["text"], contextWindow: 200_000, provider: "anthropic" },
  } as unknown as ModelOption;
}

const opus = option("claude-opus", "Claude Opus", true);
const haiku = option("claude-haiku", "Claude Haiku", false);

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  const noop = () => {};
  return {
    variant: "claude",
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
    placeholder: "How can I help you today?",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit: noop,
    pickFiles: noop,
    insertText: noop,
    send: { canSend: true, canQueue: false, streaming: false, stop: noop },
    models: {
      all: [opus, haiku],
      selected: opus,
      select: noop,
      harnesses: [{ value: "pi", label: "Pi" }],
      selectHarness: noop,
      supportsFast: (id) => id === haiku.value,
    },
    effort: {
      available: true,
      level: "high",
      label: "High",
      levels: [
        { value: "auto", label: "Auto" },
        { value: "high", label: "High" },
      ],
      select: noop,
    },
    fast: { supported: false, available: false, on: false, toggle: noop },
    menu: { open: null, toggle: noop, close: noop, query: "", setQuery: noop },
    ...over,
  };
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  lit.render(claude.render(p), host);
  return host;
}

test("the claude card renders one textarea, an accent send button and the model trigger", () => {
  const host = mount(parts());
  const form = host.querySelector("form.composer-wrap")!;
  assert.equal(form.getAttribute("data-composer"), "claude");
  assert.equal(host.querySelectorAll("textarea.composer-input").length, 1);
  assert.ok(form.querySelector("input.file-input"));
  const send = form.querySelector<HTMLButtonElement>(".claude-send")!;
  assert.equal(send.type, "submit");
  assert.equal(send.disabled, false);
  assert.equal(form.querySelector(".claude-model-btn")!.textContent!.trim(), "Claude Opus");
  assert.equal(form.querySelector(".menu-popover"), null);
});

test("a disabled send and a streaming stop follow the send state", () => {
  const idle = mount(parts({ send: { canSend: false, canQueue: false, streaming: false, stop() {} } }));
  assert.equal(idle.querySelector<HTMLButtonElement>(".claude-send")!.disabled, true);
  let stopped = 0;
  const streaming = mount(parts({ send: { canSend: true, canQueue: true, streaming: true, stop: () => stopped++ } }));
  const stop = streaming.querySelector<HTMLButtonElement>(".claude-send.claude-stop")!;
  assert.equal(stop.getAttribute("aria-label"), "Stop");
  stop.click();
  assert.equal(stopped, 1);
});

test("the model popover lists both models with descriptions and the extended thinking switch", () => {
  const p = parts();
  p.menu.open = "model";
  const host = mount(p);
  const menu = host.querySelector("#composer-model-menu")!;
  const rows = [...menu.querySelectorAll(".menu-option-label")].map((el) => el.textContent!.trim());
  assert.deepEqual(rows, ["Claude Opus", "Claude Haiku"]);
  const descs = [...menu.querySelectorAll(".claude-model-desc")].map((el) => el.textContent!.trim());
  assert.deepEqual(descs, ["Most intelligent for complex work", "Fast responses for everyday tasks"]);
  assert.equal(menu.querySelector('.menu-option[aria-checked="true"]')!.textContent!.includes("Claude Opus"), true);
  assert.ok(menu.textContent!.includes("Extended thinking"));
  const toggle = menu.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(menu.querySelector(".claude-thinking-level")!.textContent, "High");
});

test("the switch jumps between the lowest and highest effort levels", () => {
  const picked: string[] = [];
  const on = parts();
  on.menu.open = "model";
  on.effort.select = (level) => picked.push(level);
  mount(on).querySelector<HTMLButtonElement>('[role="switch"]')!.click();
  const off = parts({ effort: { ...on.effort, level: "auto", label: "Auto" } });
  off.menu.open = "model";
  const host = mount(off);
  assert.equal(host.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "false");
  assert.equal(host.querySelector(".claude-thinking-level"), null);
  host.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
  assert.deepEqual(picked, ["auto", "high"]);
});

test("the switch stays out of the popover when effort is unavailable", () => {
  const p = parts({ effort: { available: false, level: "auto", label: "Auto", levels: [], select() {} } });
  p.menu.open = "model";
  assert.equal(mount(p).querySelector('[role="switch"]'), null);
});
