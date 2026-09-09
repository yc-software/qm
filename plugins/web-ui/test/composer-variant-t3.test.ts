import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import type { ModelOption } from "../src/model-options.ts";
import type { ModelMetadata } from "../src/pi-models.ts";
import { installDom } from "./dom-harness.ts";
import { metadata } from "./model-metadata.ts";

installDom();
const lit = await import("lit");
const { getBaseModel } = await import("../src/pi-models.ts");
const { t3 } = await import("../src/composer-variants/t3.ts");

function option(id: string, name: string, harnessId: string, extra: Partial<ModelMetadata> = {}): ModelOption {
  const provider = extra.provider ?? "openai";
  return {
    value: `${harnessId}:${id}`,
    harnessId,
    harnessLabel: harnessId,
    model: getBaseModel(id, { ...metadata(id, name, provider), ...extra }),
    label: name,
    buttonLabel: name,
    groupLabel: provider,
  };
}

const gpt = option("gpt-5.6-sol", "GPT-5.6 Sol", "pi", { input: ["text", "image"] });
const o3 = option("o3", "o3", "pi", { reasoning: true, contextWindow: 1_000_000 });
const codex = option("codex-mini", "Codex Mini", "codex", { provider: "anthropic" });

function parts(over: Partial<ComposerParts> = {}): ComposerParts {
  return {
    variant: "t3",
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
    sendControls: lit.html`<button class="send-btn" type="submit">Send</button>`,
    settingsMenu: lit.html``,
    menuControl: () => lit.html``,
    placeholder: "",
    draft: "",
    inputBlocked: false,
    attachingDisabled: false,
    compact: false,
    onSubmit() {},
    pickFiles() {},
    insertText() {},
    send: { canSend: true, canQueue: false, streaming: false, stop() {} },
    models: {
      all: [gpt, o3, codex],
      selected: gpt,
      select() {},
      harnesses: [],
      selectHarness() {},
      supportsFast: (id) => id === gpt.model.id,
    },
    effort: { available: false, level: "auto", label: "Auto", levels: [], select() {} },
    fast: { supported: true, available: true, on: false, toggle() {} },
    menu: { open: null, toggle() {}, close() {}, query: "", setQuery() {} },
    ...over,
  };
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  lit.render(t3.render(p), host);
  return host;
}

const rowNames = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".t3-model .t3-model-name")].map((el) => el.textContent!.trim());
const groups = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".menu-group-label")].map((el) => el.textContent!.trim());

test("the t3 bar renders one textarea, the model trigger, fast pill, attach and send", () => {
  const host = mount(parts());
  const form = host.querySelector("form.composer-wrap")!;
  assert.equal(form.getAttribute("data-composer"), "t3");
  assert.equal(host.querySelectorAll("textarea.composer-input").length, 1);
  assert.ok(form.querySelector("input.file-input"));
  assert.equal(host.querySelector(".t3-model-trigger .t3-model-label")!.textContent!.trim(), "GPT-5.6 Sol");
  assert.equal(host.querySelector(".t3-fast")!.getAttribute("aria-pressed"), "false");
  assert.ok(host.querySelector(".t3-attach"));
  assert.ok(host.querySelector(".t3-row-right .send-btn"));
  assert.equal(host.querySelector("#composer-picker-menu"), null);
});

test("the send button is the pink rounded square", () => {
  const css = readFileSync(new URL("../src/styles/composer-t3.css", import.meta.url), "utf8");
  const rule = /\.composer-wrap\[data-composer="t3"\] \.send-btn,[\s\S]*?\{([^}]*)\}/.exec(css)!;
  assert.match(rule[1], /background: var\(--t3-accent\)/);
  assert.match(rule[1], /width: 36px/);
  assert.match(css, /--t3-accent: oklch\(0\.55 0\.2 350\)/);
});

test("the picker groups the selected harness under Favorites and badges each model's capabilities", () => {
  const host = mount(parts({ menu: { open: "picker", toggle() {}, close() {}, query: "", setQuery() {} } }));
  assert.equal(host.querySelector("#composer-picker-menu input")!.getAttribute("placeholder"), "Search models...");
  assert.deepEqual(groups(host), ["Favorites"]);
  assert.deepEqual(rowNames(host), ["GPT-5.6 Sol", "o3"]);
  const [gptRow, o3Row] = [...host.querySelectorAll(".t3-model")];
  assert.equal(gptRow!.getAttribute("aria-checked"), "true");
  assert.equal(o3Row!.getAttribute("aria-checked"), "false");
  assert.equal(gptRow!.querySelector(".t3-mark")!.textContent, "O");
  assert.deepEqual(
    [...gptRow!.querySelectorAll(".t3-badge")].map((b) => b.className),
    ["t3-badge vision", "t3-badge fast"],
  );
  assert.deepEqual(
    [...o3Row!.querySelectorAll(".t3-badge")].map((b) => b.className),
    ["t3-badge reason", "t3-badge ctx"],
  );
  assert.equal(o3Row!.querySelector(".t3-badge.ctx")!.textContent, "1M");
  assert.equal(host.querySelector(".t3-show-all")!.textContent!.trim(), "Show all");
});

test("Show all reveals the other harness's models and Show less hides them again", () => {
  const queries: Array<[string, string]> = [];
  const p = parts({
    menu: { open: "picker", toggle() {}, close() {}, query: "", setQuery: (q, kind) => void queries.push([q, kind]) },
  });
  let host = mount(p);
  host.querySelector<HTMLButtonElement>(".t3-show-all")!.click();
  assert.deepEqual(queries, [["", "picker"]]);
  host = mount(p);
  assert.deepEqual(groups(host), ["Favorites", "Others"]);
  assert.deepEqual(rowNames(host), ["GPT-5.6 Sol", "o3", "Codex Mini"]);
  assert.equal(host.querySelector(".t3-show-all")!.textContent!.trim(), "Show less");
  host.querySelector<HTMLButtonElement>(".t3-show-all")!.click();
  host = mount(p);
  assert.deepEqual(rowNames(host), ["GPT-5.6 Sol", "o3"]);
});

test("searching filters every harness, hides the footer, and reports no matches", () => {
  const menu = { open: "picker", toggle() {}, close() {}, query: "codex", setQuery() {} };
  let host = mount(parts({ menu }));
  assert.deepEqual(groups(host), ["Others"]);
  assert.deepEqual(rowNames(host), ["Codex Mini"]);
  assert.equal(host.querySelector(".t3-show-all"), null);
  host = mount(parts({ menu: { ...menu, query: "zzz" } }));
  assert.deepEqual(rowNames(host), []);
  assert.ok(host.querySelector(".menu-empty"));
});

test("typing in the search and clicking a row call back into the composer", () => {
  const calls: string[] = [];
  const host = mount(
    parts({
      menu: {
        open: "picker",
        toggle() {},
        close() {},
        query: "",
        setQuery: (q, kind) => void calls.push(`${kind}:${q}`),
      },
      models: {
        all: [gpt, o3, codex],
        selected: gpt,
        select: (value) => void calls.push(`select:${value}`),
        harnesses: [],
        selectHarness() {},
        supportsFast: () => false,
      },
    }),
  );
  const input = host.querySelector<HTMLInputElement>("#composer-picker-menu input")!;
  input.value = "o3";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  host.querySelectorAll<HTMLButtonElement>(".t3-model")[1]!.click();
  assert.deepEqual(calls, ["picker:o3", "select:pi:o3"]);
});
