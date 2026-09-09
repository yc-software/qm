import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";
import { metadata } from "./model-metadata.ts";

installDom();
const lit = await import("lit");
const { html, render } = lit;
const { getBaseModel } = await import("../src/pi-models.ts");
const { scira } = await import("../src/composer-variants/scira.ts");

function option(harnessId: string, harnessLabel: string, id: string, name: string): ModelOption {
  const meta = metadata(id, name);
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    model: getBaseModel(id, meta),
    label: name,
    buttonLabel: name,
    groupLabel: "OpenAI",
  };
}

const models = [
  option("pi", "Pi", "gpt-5.6-sol", "GPT-5.6 Sol"),
  option("pi", "Pi", "claude-opus-5", "Claude Opus 5"),
  option("codex", "Codex", "gpt-5.6-codex", "GPT-5.6 Codex"),
];
const calls: string[] = [];

function parts(open: string | null = null, fastOn = false): ComposerParts {
  return {
    variant: "scira",
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
    sendControls: html`<button class="send-btn" type="submit">Send</button>`,
    settingsMenu: html``,
    menuControl: () => html``,
    placeholder: "Ask anything",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit: (e) => e.preventDefault(),
    pickFiles() {},
    insertText() {},
    send: { canSend: true, canQueue: false, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0]!,
      select: (value) => void calls.push(`select:${value}`),
      harnesses: [
        { value: "pi", label: "Pi" },
        { value: "codex", label: "Codex" },
      ],
      selectHarness: (id) => void calls.push(`harness:${id}`),
      supportsFast: () => true,
    },
    effort: { available: true, level: "auto", label: "Auto", levels: [], select() {} },
    fast: { supported: true, available: true, on: fastOn, toggle: () => void calls.push("fast") },
    redraw() {},
    queue: { runs: [], steerable: false, remove() {}, steer() {} },
    menu: {
      open,
      toggle: (_e, kind) => void calls.push(`toggle:${kind}`),
      set: (kind) => void calls.push(`set:${kind}`),
      close: () => void calls.push("close"),
      query: "",
      setQuery() {},
    },
  };
}

const host = document.getElementById("app")!;
const draw = (p: ComposerParts): HTMLFormElement => {
  render(scira.render(p), host);
  return host.querySelector("form")!;
};

test("the form carries the variant marker and renders the textarea once", () => {
  const form = draw(parts());
  assert.equal(form.dataset.composer, "scira");
  assert.equal(form.querySelectorAll("textarea.composer-input").length, 1);
  assert.ok(form.querySelector("input.file-input"));
});

test("the plus badge counts the active harness plus fast mode", () => {
  assert.equal(draw(parts()).querySelector(".scira-badge")!.textContent, "1");
  assert.equal(draw(parts(null, true)).querySelector(".scira-badge")!.textContent, "2");
});

test("the sources row lists harness chips with the selected one checked", () => {
  calls.length = 0;
  const form = draw(parts("sources"));
  const chips = [...form.querySelectorAll<HTMLButtonElement>(".scira-chip")];
  assert.deepEqual(
    chips.map((c) => [c.textContent!.trim(), c.getAttribute("aria-checked")]),
    [
      ["Pi", "true"],
      ["Codex", "false"],
      ["Fast", "false"],
    ],
  );
  chips[1]!.click();
  assert.deepEqual(calls, ["harness:codex"]);
});

test("the voice bar shows a timer and an End control, and its tick stops when it closes", () => {
  calls.length = 0;
  const form = draw(parts("voice"));
  assert.match(form.querySelector(".scira-voice-time")!.textContent!, /^\d{2}:\d{2}$/);
  assert.equal(form.querySelectorAll(".scira-eq i").length, 24);
  assert.equal(form.querySelector(".send-btn"), null);
  form.querySelector<HTMLButtonElement>(".scira-voice-end")!.click();
  assert.deepEqual(calls, ["close"]);
  const closed = draw(parts());
  assert.equal(closed.querySelector(".scira-voice"), null);
  assert.ok(closed.querySelector(".send-btn"));
});

test("typing a trailing @ opens the mentions menu once", () => {
  calls.length = 0;
  const form = draw(parts());
  const ta = form.querySelector<HTMLTextAreaElement>("textarea")!;
  for (const value of ["hi @", "hi @", "hi @c", "hi @c @"]) {
    ta.value = value;
    ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  assert.deepEqual(calls, ["set:mentions", "set:mentions"]);
  const open = draw(parts("mentions"));
  const rows = [...open.querySelectorAll("#composer-mentions-menu .menu-option")];
  assert.equal(rows.length, 3);
  assert.match(rows[0]!.textContent!, /@gpt-5\.6-sol/);
  (rows[2] as HTMLButtonElement).click();
  assert.deepEqual(calls.slice(2), ["select:codex:gpt-5.6-codex", "close"]);
});
