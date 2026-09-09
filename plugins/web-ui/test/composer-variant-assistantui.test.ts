import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";

installDom();
const lit = await import("lit");
const { html, render } = lit;
const { assistantui } = await import("../src/composer-variants/assistantui.ts");

function option(id: string, contextWindow: number, model: Partial<ModelOption["model"]> = {}): ModelOption {
  return {
    value: `pi:${id}`,
    harnessId: "pi",
    harnessLabel: "Pi",
    label: id,
    buttonLabel: id,
    groupLabel: "OpenAI",
    model: {
      id,
      name: id,
      provider: "openai",
      contextWindow,
      input: ["text"],
      reasoning: false,
      ...model,
    } as ModelOption["model"],
  };
}

const small = option("gpt-5.6-sol", 200_000, { input: ["text", "image"] });
const large = option("gemini-3-ultra", 1_000_000, { reasoning: true });
const noop = (): void => {};

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "assistantui",
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
    placeholder: "",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit: noop,
    pickFiles: noop,
    insertText: noop,
    send: { canSend: true, canQueue: false, streaming: false, stop: noop },
    models: {
      all: [small, large],
      selected: small,
      select: noop,
      harnesses: [{ value: "pi", label: "Pi" }],
      selectHarness: noop,
      supportsFast: () => false,
    },
    effort: {
      available: true,
      level: "medium",
      label: "Medium",
      levels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
      select: noop,
    },
    fast: { supported: true, available: true, on: false, toggle: noop },
    redraw: noop,
    queue: { runs: [], steerable: false, remove: noop, steer: noop },
    menu: { open: null, toggle: noop, set: noop, close: noop, query: "", setQuery: noop },
    ...over,
  };
}

const host = document.getElementById("app")!;
const menu = (open: string | null): ComposerParts["menu"] => ({ ...parts().menu, open });

function draw(over: Partial<ComposerParts> = {}): HTMLElement {
  render(assistantui.render(parts(over)), host);
  return host;
}

const text = (selector: string): string[] =>
  [...host.querySelectorAll(selector)].map((el) => el.textContent!.replace(/\s+/g, " ").trim());

test("renders the assistantui bar with one textarea slot and the file input inside the form", () => {
  draw();
  const form = host.querySelector("form.composer-wrap")!;
  assert.equal(form.getAttribute("data-composer"), "assistantui");
  assert.equal(host.querySelectorAll("textarea").length, 1);
  assert.ok(form.querySelector("input.file-input"));
  assert.ok(form.querySelector('[aria-label="Attach files"]'));
  assert.ok(form.querySelector(".send-btn"));
});

test("the context ring reads draft tokens against the selected window and turns hot past 85%", () => {
  draw({ draft: "x".repeat(4000) });
  assert.deepEqual(text(".au-readout"), ["1%"]);
  assert.equal(host.querySelector(".au-ring")!.classList.contains("hot"), false);
  assert.match(text(".au-ctx-panel")[0], /^System 1\.5k · Draft 1k · Attachments 0 · Window 200k$/);

  draw({ draft: "x".repeat(700_000) });
  assert.deepEqual(text(".au-readout"), ["88%"]);
  assert.ok(host.querySelector(".au-ring.hot .au-readout"));

  draw({ draft: "x".repeat(700_000), models: { ...parts().models, selected: large } });
  assert.deepEqual(text(".au-readout"), ["18%"]);
  assert.equal(host.querySelector(".au-ring")!.classList.contains("hot"), false);
});

test("the model menu lists capability chips per model and a Thinking row when effort is available", () => {
  draw({ menu: menu("model") });
  assert.ok(host.querySelector('#composer-model-menu[role="menu"]'));
  assert.deepEqual(text(".menu-group-label"), ["Pi"]);
  assert.deepEqual(text(".au-cap"), ["Vision", "200K", "Reasoning", "1000K"]);
  assert.deepEqual(text(".au-effort .au-chip"), ["Low", "Medium", "High"]);
  assert.equal(host.querySelector(".au-effort .au-chip.active")!.textContent!.trim(), "Medium");
  assert.match(text(".au-foot-label")[0], /^Thinking$/);

  draw({ menu: menu("model"), effort: { ...parts().effort, available: false } });
  assert.equal(host.querySelector(".au-effort"), null);
  assert.equal(host.querySelector('#composer-model-menu .au-chip[aria-pressed="false"]')!.textContent!.trim(), "Fast");
});

test("the mentions menu lists models as @handles", () => {
  draw({ menu: menu("mentions") });
  assert.deepEqual(text("#composer-mentions-menu .au-handle"), ["@gpt-5.6-sol", "@gemini-3-ultra"]);
});

test("the voice bar replaces the toolbar with waveform bars, a timer and an End control", () => {
  draw({ menu: menu("voice") });
  assert.equal(host.querySelector(".composer-toolbar"), null);
  assert.equal(host.querySelectorAll(".au-wave-bar").length, 20);
  assert.deepEqual(text(".au-end"), ["End"]);
  assert.match(text(".au-voice-clock")[0], /^\d\d:\d\d$/);
  assert.equal(host.querySelectorAll("textarea").length, 1);

  draw();
  assert.equal(host.querySelector(".au-voice"), null);
  assert.ok(host.querySelector(".composer-toolbar"));
});
