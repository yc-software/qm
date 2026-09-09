import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import {
  ArrowUp,
  AtSign,
  Bug,
  Check,
  ChevronDown,
  Code,
  CornerDownRight,
  Image,
  MessageCircleQuestionMark,
  Pencil,
  PenTool,
  Square,
  X,
  type IconNode,
} from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import type { QueuedRun } from "../core-bridge";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const MODES: ReadonlyArray<{ id: string; label: string; glyph: IconNode; hint: string }> = [
  { id: "code", label: "Code", glyph: Code, hint: "Write, refactor and fix code" },
  { id: "architect", label: "Architect", glyph: PenTool, hint: "Plan and design before writing code" },
  { id: "ask", label: "Ask", glyph: MessageCircleQuestionMark, hint: "Answer questions about the codebase" },
  { id: "debug", label: "Debug", glyph: Bug, hint: "Diagnose and fix problems" },
];

let mode = MODES[0]!;

function popover(p: ComposerParts, kind: string, body: () => unknown) {
  if (p.menu.open !== kind) return nothing;
  return html`<div
    class="menu-popover"
    id="composer-${kind}-menu"
    role="menu"
    @click=${(e: Event) => e.stopPropagation()}
  >
    ${body()}
  </div>`;
}

function queuedRow(p: ComposerParts, run: QueuedRun) {
  return html`
    <div class="kilo-queued" role="listitem">
      <span class="kilo-queued-tag">Queued</span>
      <span class="kilo-queued-text" dir="auto">${run.text || (run.hasAttachments ? "(files)" : "")}</span>
      <button
        class="kilo-ghost"
        type="button"
        aria-label="Edit queued message"
        @click=${() => {
          p.queue.remove(run);
          p.insertText(run.text);
        }}
      >
        ${icon(Pencil, 12)}
      </button>
      <button
        class="kilo-ghost"
        type="button"
        aria-label="Steer the running task with this message"
        ?disabled=${!p.queue.steerable || run.hasAttachments}
        @click=${() => p.queue.steer(run)}
      >
        ${icon(CornerDownRight, 12)}
      </button>
      <button class="kilo-ghost" type="button" aria-label="Remove queued message" @click=${() => p.queue.remove(run)}>
        ${icon(X, 12)}
      </button>
    </div>
  `;
}

function queue(p: ComposerParts) {
  if (!p.queue.runs.length) return nothing;
  return html`<div class="kilo-queue" role="list" aria-label="Queued messages">
    ${p.queue.runs.map((run) => queuedRow(p, run))}
  </div>`;
}

function modeMenu(p: ComposerParts) {
  const open = p.menu.open === "mode";
  return html`
    <div class="menu-control kilo-mode" data-align="left" data-drop="up">
      <button
        class="menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-mode-menu"
        @click=${(e: Event) => p.menu.toggle(e, "mode")}
      >
        <span class="menu-label">${mode.label}</span>
        ${icon(ChevronDown, 10)}
      </button>
      ${popover(p, "mode", () =>
        MODES.map(
          (m) => html`
            <button
              class="menu-option ${m === mode ? "active" : ""}"
              type="button"
              role="menuitemradio"
              aria-checked=${m === mode ? "true" : "false"}
              @click=${() => {
                mode = m;
                p.menu.close();
              }}
            >
              ${icon(m.glyph, 12)}
              <span class="menu-option-copy">
                <span class="menu-option-label">${m.label}</span>
                <span class="kilo-hint">${m.hint}</span>
              </span>
            </button>
          `,
        ),
      )}
    </div>
  `;
}

function modelRow(p: ComposerParts, option: ModelOption) {
  const selected = option.value === p.models.selected.value;
  return html`
    <button
      class="menu-option ${selected ? "active" : ""}"
      type="button"
      role="menuitemradio"
      aria-checked=${selected ? "true" : "false"}
      @click=${() => p.models.select(option.value)}
    >
      <span class="menu-option-label kilo-mono">${option.model.id}</span>
      <span class="kilo-spacer"></span>
      ${selected ? icon(Check, 12) : nothing}
    </button>
  `;
}

function byHarness(p: ComposerParts, query = "") {
  const groups = new Map<string, ModelOption[]>();
  for (const m of p.models.all) {
    if (query && !`${m.model.id} ${m.label} ${m.harnessLabel}`.toLocaleLowerCase().includes(query)) continue;
    groups.set(m.harnessLabel, [...(groups.get(m.harnessLabel) ?? []), m]);
  }
  return [...groups].map(
    ([label, options]) => html`
      <div class="menu-group-label">${label}</div>
      ${options.map((m) => modelRow(p, m))}
    `,
  );
}

function modelMenu(p: ComposerParts) {
  const open = p.menu.open === "model";
  return html`
    <div class="menu-control kilo-model" data-align="left" data-drop="up">
      <button
        class="menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-model-menu"
        @click=${(e: Event) => p.menu.toggle(e, "model")}
      >
        <span class="menu-label">${p.models.selected.model.id}</span>
        ${icon(ChevronDown, 10)}
      </button>
      ${popover(p, "model", () => {
        const groups = byHarness(p, p.menu.query.trim().toLocaleLowerCase());
        return html`
          <label class="menu-search">
            <input
              type="search"
              placeholder="Search models"
              aria-label="Search models"
              .value=${live(p.menu.query)}
              @input=${(e: InputEvent) => p.menu.setQuery((e.currentTarget as HTMLInputElement).value, "model")}
            />
          </label>
          ${groups.length ? groups : html`<div class="menu-empty">No models found</div>`}
        `;
      })}
    </div>
  `;
}

function mentionsMenu(p: ComposerParts) {
  const open = p.menu.open === "mentions";
  return html`
    <div class="menu-control kilo-mentions" data-align="left" data-drop="up">
      <button
        class="icon-btn"
        type="button"
        aria-label="Add context"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-mentions-menu"
        ?disabled=${p.inputBlocked}
        @click=${() => {
          p.insertText("@");
          p.menu.set("mentions");
        }}
      >
        ${icon(AtSign, 13)}
      </button>
      ${popover(
        p,
        "mentions",
        () => html`
          <div class="menu-title">Add context</div>
          <button
            class="menu-option"
            type="button"
            role="menuitem"
            @click=${() => {
              p.pickFiles();
              p.menu.close();
            }}
          >
            ${icon(Image, 12)}
            <span class="menu-option-label">Files…</span>
          </button>
          <button
            class="menu-option"
            type="button"
            role="menuitem"
            @click=${() => {
              p.insertText("/");
              p.menu.close();
            }}
          >
            ${icon(Code, 12)}
            <span class="menu-option-label">Skills</span>
          </button>
          ${byHarness(p)}
        `,
      )}
    </div>
  `;
}

function sendButton(p: ComposerParts) {
  if (p.send.streaming)
    return html`<button class="stop-btn" type="button" aria-label="Stop" @click=${() => p.send.stop()}>
      ${icon(Square, 10)}
    </button>`;
  return html`<button class="send-btn" type="submit" aria-label="Send" ?disabled=${!p.send.canSend}>
    ${icon(ArrowUp, 12)}
  </button>`;
}

export const kilo: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="kilo" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${queue(p)} ${p.attachments} ${p.textarea}
      <div class="composer-toolbar">
        <div class="composer-left">${p.fileInput} ${modeMenu(p)} ${modelMenu(p)} ${mentionsMenu(p)}</div>
        <div class="composer-right">
          <button
            class="icon-btn"
            type="button"
            aria-label="Attach image"
            ?disabled=${p.attachingDisabled}
            @click=${() => p.pickFiles()}
          >
            ${icon(Image, 14)}
          </button>
          ${p.send.streaming ? nothing : html`<kbd>⌘↵</kbd>`} ${sendButton(p)}
        </div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
