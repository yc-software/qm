import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import { installDom } from "./dom-harness.ts";

installDom('<!doctype html><div id="host"></div>');
const lit = await import("lit");
const { html, render } = lit;
const nothing: typeof lit.nothing = lit.nothing;
const vite = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true },
});
const { modal } = (await vite.ssrLoadModule(
  "/src/composer-variants/modal.ts",
)) as typeof import("../src/composer-variants/modal.ts");
after(() => vite.close());

function option(harnessId: string, harnessLabel: string, id: string, label: string, vision = false): ModelOption {
  const model = {
    id,
    name: label,
    provider: "openai",
    reasoning: vision,
    input: vision ? ["text", "image"] : ["text"],
  };
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel,
    label,
    buttonLabel: label,
    groupLabel: "OpenAI",
    model: { ...model, contextWindow: 200000 } as unknown as ModelOption["model"],
  };
}

const models = [
  option("pi", "Pi", "gpt-a", "GPT A", true),
  option("pi", "Pi", "gpt-b", "GPT B"),
  option("claude", "Claude Code", "opus", "Opus"),
];

function fakeParts(over: { open?: string | null; fastOn?: boolean; fastAvailable?: boolean; query?: string } = {}) {
  const calls: string[] = [];
  const parts = {
    variant: "modal",
    header: nothing,
    slashMenu: nothing,
    upgradeNotice: nothing,
    attachments: nothing,
    approvals: nothing,
    notice: nothing,
    textarea: html`<textarea class="composer-input"></textarea>`,
    fileInput: html`<input class="file-input" type="file" hidden />`,
    pasteDialog: nothing,
    defaultButtons: html`<button class="runtime-default-btn" type="button">Make default</button>`,
    sendControls: html`<button class="send-btn" type="submit">Send</button>`,
    settingsMenu: html``,
    menuControl: () => html``,
    placeholder: "Ask anything",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit: () => calls.push("submit"),
    pickFiles: () => calls.push("pick"),
    insertText: () => {},
    send: { canSend: true, canQueue: false, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0]!,
      select: (value: string) => calls.push(`select:${value}`),
      harnesses: [
        { value: "pi", label: "Pi" },
        { value: "claude", label: "Claude Code" },
      ],
      selectHarness: (harnessId: string) => calls.push(`harness:${harnessId}`),
      supportsFast: () => true,
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
      select: (level: string) => calls.push(`effort:${level}`),
    },
    fast: {
      supported: true,
      available: over.fastAvailable ?? true,
      on: over.fastOn ?? false,
      toggle: () => calls.push("fast"),
    },
    redraw() {},
    queue: { runs: [], steerable: false, remove() {}, steer() {} },
    menu: {
      open: over.open ?? null,
      toggle: (_e: Event, kind: string) => calls.push(`toggle:${kind}`),
      set() {},
      close: () => calls.push("close"),
      query: over.query ?? "",
      setQuery: (query: string) => calls.push(`query:${query}`),
    },
  } satisfies ComposerParts;
  return { parts, calls };
}

function mount(over: Parameters<typeof fakeParts>[0] = {}) {
  const host = document.getElementById("host")!;
  const { parts, calls } = fakeParts(over);
  render(modal.render(parts), host);
  return { host, calls };
}

const texts = (root: ParentNode, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((el) => el.textContent!.replace(/\s+/g, " ").trim());

test("the bar is QM's own row with one chip summarising model, effort and fast mode", () => {
  const { host, calls } = mount();
  assert.ok(host.querySelector('form.composer-wrap[data-composer="modal"]'));
  assert.equal(host.querySelectorAll("textarea").length, 1);
  assert.equal(host.querySelectorAll('input[type="file"]').length, 1);
  const chip = host.querySelector<HTMLButtonElement>(".menu-control .modal-chip")!;
  assert.equal(chip.getAttribute("aria-haspopup"), "dialog");
  assert.match(chip.textContent!, /GPT A · Medium/);
  assert.doesNotMatch(chip.textContent!, /Fast/);
  assert.equal(host.querySelector('[role="dialog"]'), null);
  chip.click();
  assert.deepEqual(calls, ["toggle:picker"]);
  host.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!.click();
  assert.deepEqual(calls, ["toggle:picker", "pick"]);
});

test("the chip appends Fast when fast mode is on", () => {
  const { host } = mount({ fastOn: true });
  assert.match(host.querySelector(".modal-chip")!.textContent!, /GPT A · Medium · Fast/);
});

test("opening the picker renders a modal dialog with harness rail, filtered models, switch and effort list", () => {
  const { host, calls } = mount({ open: "picker", fastOn: true });
  const dialog = host.querySelector<HTMLElement>('#composer-picker-menu[role="dialog"]')!;
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("aria-label"), "Model and speed");
  assert.deepEqual(texts(dialog, ".modal-harness-label"), ["Pi", "Claude Code"]);
  assert.deepEqual(texts(dialog, '.modal-harness[aria-pressed="true"] .modal-harness-label'), ["Pi"]);
  assert.deepEqual(texts(dialog, ".modal-model-name"), ["GPT A", "GPT B"]);
  assert.deepEqual(texts(dialog, '.modal-model[aria-selected="true"] .modal-model-name'), ["GPT A"]);
  assert.deepEqual(texts(dialog, '.modal-model[aria-selected="true"] .modal-cap'), [
    "Vision",
    "Reasoning",
    "200K context",
  ]);
  assert.equal(dialog.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
  assert.deepEqual(texts(dialog, '[role="radio"]'), ["Low", "Medium", "High"]);
  assert.deepEqual(texts(dialog, '[role="radio"][aria-checked="true"]'), ["Medium"]);
  assert.ok(dialog.querySelector(".modal-defaults .runtime-default-btn"));

  dialog.querySelectorAll<HTMLButtonElement>(".modal-model")[1]!.click();
  dialog.querySelectorAll<HTMLButtonElement>(".modal-harness")[1]!.click();
  dialog.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
  dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')[2]!.click();
  assert.deepEqual(calls, ["select:pi:gpt-b", "harness:claude", "fast", "effort:high"]);
});

test("the switch is off and disabled with a note when fast mode is unavailable", () => {
  const { host } = mount({ open: "picker", fastAvailable: false });
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(toggle.disabled, true);
  assert.deepEqual(texts(host, ".modal-field-note"), ["Not available for this model"]);
  assert.equal(mount({ open: "picker" }).host.querySelector(".modal-field-note"), null);
});

test("the search query narrows the selected harness's models", () => {
  const { host } = mount({ open: "picker", query: "b" });
  assert.deepEqual(texts(host, ".modal-model-name"), ["GPT B"]);
});

test("clicking the scrim closes the picker while clicks inside the panel do not", () => {
  const { host, calls } = mount({ open: "picker" });
  host.querySelector<HTMLElement>("#composer-picker-menu")!.click();
  assert.deepEqual(calls, []);
  host.querySelector<HTMLElement>(".modal-scrim")!.click();
  assert.deepEqual(calls, ["close"]);
  host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
  assert.deepEqual(calls, ["close", "close"]);
});
