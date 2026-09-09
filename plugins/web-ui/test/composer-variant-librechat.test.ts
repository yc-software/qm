import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerParts } from "../src/composer-parts.ts";
import { installDom } from "./dom-harness.ts";

installDom();
const { html, nothing, render } = await import("lit");
const { librechat } = await import("../src/composer-variants/librechat.ts");

const model = (id: string, harnessId: string, harnessLabel: string) => ({
  value: `${harnessId}:${id}`,
  harnessId,
  harnessLabel,
  model: { id },
  label: id,
  buttonLabel: id,
  groupLabel: "Acme",
});
const models = [model("sol-1", "pi", "Pi"), model("opus-9", "claude", "Claude Code")];

function parts(
  over: Partial<{ fastOn: boolean; effortAvailable: boolean; approvals: unknown; open: string | null }> = {},
): ComposerParts {
  return {
    variant: "librechat",
    header: nothing,
    slashMenu: nothing,
    upgradeNotice: nothing,
    attachments: nothing,
    approvals: over.approvals ?? nothing,
    notice: nothing,
    textarea: html`<textarea class="composer-input"></textarea>`,
    fileInput: html`<input class="file-input" type="file" hidden />`,
    pasteDialog: nothing,
    defaultButtons: nothing,
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
    send: { canSend: true, canQueue: false, streaming: false, stop() {} },
    models: {
      all: models,
      selected: models[0],
      select() {},
      harnesses: [
        { value: "pi", label: "Pi" },
        { value: "claude", label: "Claude Code" },
      ],
      selectHarness() {},
      supportsFast: () => true,
    },
    effort: {
      available: over.effortAvailable ?? false,
      level: "medium",
      label: "Medium",
      levels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
      ],
      select() {},
    },
    fast: { supported: true, available: true, on: over.fastOn ?? false, toggle() {} },
    redraw() {},
    queue: { runs: [], steerable: false, remove() {}, steer() {} },
    menu: { open: over.open ?? null, toggle() {}, set() {}, close() {}, query: "", setQuery() {} },
  } as unknown as ComposerParts;
}

function mount(p: ComposerParts): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  render(librechat.render(p), host);
  return host;
}

const text = (host: HTMLElement, selector: string): string => host.querySelector(selector)!.textContent!.trim();

test("renders the librechat bar with a single textarea slot", () => {
  const host = mount(parts());
  assert.equal(host.querySelector("form.composer-wrap")!.getAttribute("data-composer"), "librechat");
  assert.equal(host.querySelectorAll("textarea").length, 1);
});

test("the model spec chip shows the selected model's button label", () => {
  assert.equal(text(mount(parts()), ".lc-spec .lc-chip-label"), "sol-1");
});

test("the tools chip counts fast mode and effort as active capabilities", () => {
  assert.equal(text(mount(parts()), ".lc-count"), "0");
  assert.equal(text(mount(parts({ fastOn: true })), ".lc-count"), "1");
  assert.equal(text(mount(parts({ fastOn: true, effortAvailable: true })), ".lc-count"), "2");
});

test("the pending actions tray only appears with approvals", () => {
  assert.equal(mount(parts()).querySelector(".lc-tray-head"), null);
  const host = mount(parts({ approvals: html`<div class="composer-approval-panel">approve?</div>` }));
  assert.equal(text(host, ".lc-tray-head"), "Review pending actions");
  assert.ok(host.querySelector(".lc-tray .composer-approval-panel"));
});

test("the open model menu groups models under their harness", () => {
  const host = mount(parts({ open: "model" }));
  const headings = [...host.querySelectorAll("#composer-model-menu .menu-group-label")].map((el) =>
    el.textContent!.trim(),
  );
  assert.deepEqual(headings, ["Pi", "Claude Code"]);
});
