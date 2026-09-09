import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { QueuedRun } from "../src/core-bridge.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";

installDom();
const lit = await import("lit");
const { html, render } = lit;
const nothing: typeof lit.nothing = lit.nothing;
const { kilo } = await import("../src/composer-variants/kilo.ts");

function model(harnessId: string, harnessLabel: string, id: string): ModelOption {
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    label: id,
    buttonLabel: id,
    groupLabel: harnessLabel,
    model: { id, reasoning: false, contextWindow: 400_000, provider: "openai", input: ["text"] },
  } as unknown as ModelOption;
}

const models = [
  model("pi", "Pi", "gpt-5.6-sol"),
  model("pi", "Pi", "gpt-5.6-pro"),
  model("opencode", "OpenCode", "claude-fable-5-1"),
];
const runs: QueuedRun[] = [
  { runId: "q1", text: "Fix the failing tests" },
  { runId: "q2", text: "Then ship it", hasAttachments: true },
];
const calls: string[] = [];

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "kilo",
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
    placeholder: "Type your task here",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit() {},
    pickFiles: () => void calls.push("pickFiles"),
    insertText: (text) => void calls.push(`insert:${text}`),
    redraw() {},
    send: { canSend: false, canQueue: false, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0]!,
      select: (value) => void calls.push(`select:${value}`),
      harnesses: [],
      selectHarness() {},
      supportsFast: () => false,
    },
    effort: { available: false, level: "auto", label: "Auto", levels: [], select() {} },
    fast: { supported: false, available: false, on: false, toggle() {} },
    queue: {
      runs,
      steerable: false,
      remove: (run) => void calls.push(`remove:${run.runId}`),
      steer: (run) => void calls.push(`steer:${run.runId}`),
    },
    menu: {
      open: null,
      toggle() {},
      set: (kind) => void calls.push(`menu:${kind}`),
      close() {},
      query: "",
      setQuery() {},
    },
    ...over,
  };
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  render(kilo.render(p), host);
  return host;
}

const withMenu = (p: ComposerParts, open: string): ComposerParts => ({ ...p, menu: { ...p.menu, open } });

test("renders the kilo form with one textarea slot and the file input inside it", () => {
  const host = mount(parts());
  const form = host.querySelector("form.composer-wrap")!;
  assert.equal(form.getAttribute("data-composer"), "kilo");
  assert.equal(host.querySelectorAll("textarea.composer-input").length, 1);
  assert.ok(form.querySelector("input.file-input"));
});

test("both queued messages render inside the form above the textarea", () => {
  const form = mount(parts()).querySelector("form.composer-wrap")!;
  const rows = [...form.querySelectorAll(".kilo-queued")];
  assert.deepEqual(
    rows.map((row) => row.querySelector(".kilo-queued-text")!.textContent!.trim()),
    ["Fix the failing tests", "Then ship it"],
  );
  assert.equal(rows[0]!.querySelector(".kilo-queued-text")!.getAttribute("dir"), "auto");
  const order = [...form.querySelectorAll(".kilo-queue, textarea")].map((el) => el.tagName.toLowerCase());
  assert.deepEqual(order, ["div", "textarea"]);
});

test("Edit removes the queued message and puts its text back in the field", () => {
  calls.length = 0;
  mount(parts()).querySelector<HTMLButtonElement>('.kilo-queued [aria-label="Edit queued message"]')!.click();
  assert.deepEqual(calls, ["remove:q1", "insert:Fix the failing tests"]);
});

test("Steer is disabled while nothing steerable is running and for messages carrying files", () => {
  const steer = (p: ComposerParts) =>
    [...mount(p).querySelectorAll<HTMLButtonElement>('.kilo-queued [aria-label^="Steer"]')].map((b) => b.disabled);
  assert.deepEqual(steer(parts()), [true, true]);
  const p = parts();
  assert.deepEqual(steer({ ...p, queue: { ...p.queue, steerable: true } }), [false, true]);
});

test("the mode trigger reads Code and the model trigger shows the selected id", () => {
  const host = mount(parts());
  assert.equal(host.querySelector(".kilo-mode .menu-label")!.textContent!.trim(), "Code");
  assert.equal(host.querySelector(".kilo-model .menu-label")!.textContent!.trim(), "gpt-5.6-sol");
});

test("the open model menu lists mono ids under both harness headings with a check on the selected one", () => {
  const menu = mount(withMenu(parts(), "model")).querySelector("#composer-model-menu")!;
  assert.deepEqual(
    [...menu.querySelectorAll(".menu-group-label")].map((el) => el.textContent!.trim()),
    ["Pi", "OpenCode"],
  );
  assert.deepEqual(
    [...menu.querySelectorAll(".menu-option .kilo-mono")].map((el) => el.textContent!.trim()),
    ["gpt-5.6-sol", "gpt-5.6-pro", "claude-fable-5-1"],
  );
  assert.deepEqual(
    [...menu.querySelectorAll(".menu-option")].map((row) => row.getAttribute("aria-checked")),
    ["true", "false", "false"],
  );
});

test("the @ button inserts an @ and opens a mentions menu that stays open once the draft has a space", () => {
  calls.length = 0;
  mount(parts()).querySelector<HTMLButtonElement>('[aria-label="Add context"]')!.click();
  assert.deepEqual(calls, ["insert:@", "menu:mentions"]);
  const menu = mount(withMenu({ ...parts(), draft: "@ src/" }, "mentions")).querySelector("#composer-mentions-menu")!;
  assert.ok(menu);
  assert.deepEqual([...menu.querySelectorAll(".menu-option-label")].map((el) => el.textContent!.trim()).slice(0, 2), [
    "Files…",
    "Skills",
  ]);
});
