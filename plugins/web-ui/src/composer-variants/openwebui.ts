import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardPaste,
  FileText,
  Mic,
  Plus,
  Slash,
  Square,
  Upload,
  type IconNode,
} from "lucide";
import type { ComposerParts, ComposerVariantModule, Tpl } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { tip } from "../tooltip.ts";
import { icon } from "../ui.ts";

let mentionArmed = false;
let modelCommandArmed = false;

function syncTriggers(draft: string, p: ComposerParts): void {
  if (draft.endsWith("@")) {
    if (!mentionArmed) {
      mentionArmed = true;
      queueMicrotask(() => p.menu.set("mentions"));
    }
  } else mentionArmed = false;
  if (/^\/model/i.test(draft)) {
    if (!modelCommandArmed && p.menu.open !== "model") {
      modelCommandArmed = true;
      queueMicrotask(() => p.menu.set("model"));
    }
  } else modelCommandArmed = false;
}

function onFormInput(e: Event, p: ComposerParts): void {
  const el = e.target as HTMLTextAreaElement;
  if (el.tagName === "TEXTAREA") syncTriggers(el.value, p);
}

const stop = (e: Event): void => e.stopPropagation();

function row(glyph: IconNode, label: string, onClick: () => void): TemplateResult {
  return html`<button class="menu-option" type="button" role="menuitem" @click=${onClick}>
    <span class="menu-option-copy">${icon(glyph, 16)}<span class="menu-option-label">${label}</span></span>
  </button>`;
}

function describe(p: ComposerParts, m: ModelOption): string {
  if (m.model.reasoning) return "Reasoning model";
  return p.models.supportsFast(m.model.id) ? "Fast responses" : "General model";
}

function modelRow(p: ComposerParts, m: ModelOption): TemplateResult {
  const selected = m.value === p.models.selected.value;
  return html`<button
    class="menu-option owui-model-row ${selected ? "active" : ""}"
    type="button"
    role="menuitemradio"
    aria-checked=${selected ? "true" : "false"}
    @click=${() => p.models.select(m.value)}
  >
    <span class="owui-mark" aria-hidden="true">${m.harnessLabel.charAt(0)}</span>
    <span class="menu-option-copy">
      <span class="menu-option-label">${m.label}</span>
      <span class="owui-desc">${describe(p, m)}</span>
    </span>
    ${selected ? icon(Check, 15) : nothing}
  </button>`;
}

function modelPanel(p: ComposerParts, kind: string): TemplateResult {
  const query = p.menu.query.trim().toLocaleLowerCase();
  const matches = query
    ? p.models.all.filter((m) => `${m.label} ${m.harnessLabel}`.toLocaleLowerCase().includes(query))
    : p.models.all;
  const current = p.models.selected.harnessId;
  const groups = [...p.models.harnesses]
    .sort((a, b) => Number(b.value === current) - Number(a.value === current))
    .map((h) => ({ ...h, options: matches.filter((m) => m.harnessId === h.value) }))
    .filter((g) => g.options.length);
  return html`<div class="menu-popover owui-models" id="composer-${kind}-menu" role="menu" @click=${stop}>
    <label class="menu-search">
      <span class="sr-only">Search models</span>
      <input
        type="search"
        placeholder="Search models…"
        .value=${live(p.menu.query)}
        @keydown=${(e: KeyboardEvent) => e.key === "Enter" && e.preventDefault()}
        @input=${(e: InputEvent) => p.menu.setQuery((e.currentTarget as HTMLInputElement).value, kind)}
      />
    </label>
    ${
      groups.length
        ? groups.map(
            (g) =>
              html`<div class="menu-group-label">${g.label}</div>
                ${g.options.map((m) => modelRow(p, m))}`,
          )
        : html`<div class="menu-empty">No models found</div>`
    }
  </div>`;
}

function actionsMenu(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "actions";
  return html`<div class="menu-control" data-align="left" data-drop="up">
    <button
      class="owui-round"
      type="button"
      aria-label="More"
      ${tip("More")}
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-controls="composer-actions-menu"
      ?disabled=${p.inputBlocked}
      @click=${(e: Event) => p.menu.toggle(e, "actions")}
    >
      ${icon(Plus, 18)}
    </button>
    ${
      open
        ? html`<div class="menu-popover" id="composer-actions-menu" role="menu" @click=${stop}>
            ${row(Upload, "Upload files", () => {
              p.menu.close();
              p.pickFiles();
            })}
            ${row(ClipboardPaste, "Paste text", () => p.menu.close())}
            ${row(Slash, "Use a skill", () => {
              p.menu.close();
              p.insertText("/");
            })}
          </div>`
        : nothing
    }
  </div>`;
}

function mentionsMenu(p: ComposerParts): Tpl {
  if (p.menu.open !== "mentions") return nothing;
  return html`<div class="menu-control" data-align="left" data-drop="up">
    <div class="menu-popover owui-models" id="composer-mentions-menu" role="menu" @click=${stop}>
      <div class="menu-group-label">Attach</div>
      ${row(FileText, "Files…", () => {
        p.menu.close();
        p.pickFiles();
      })}
      ${row(Slash, "Skills", () => {
        p.menu.close();
        p.insertText("/");
      })}
      <div class="menu-group-label">Models</div>
      ${p.models.all.map((m) => modelRow(p, m))}
    </div>
  </div>`;
}

function modelMenu(p: ComposerParts): Tpl {
  if (p.menu.open !== "model") return nothing;
  return html`<div class="menu-control" data-align="left" data-drop="up">${modelPanel(p, "model")}</div>`;
}

function sendButton(p: ComposerParts): TemplateResult {
  if (p.send.streaming)
    return html`<button class="stop-btn" type="button" aria-label="Stop" ${tip("Stop")} @click=${p.send.stop}>
      ${icon(Square, 12)}
    </button>`;
  return html`<button class="send-btn" type="submit" aria-label="Send" ${tip("Send")} ?disabled=${!p.send.canSend}>
    ${icon(ArrowUp, 18)}
  </button>`;
}

export const openwebui: ComposerVariantModule = {
  render: (p) => {
    syncTriggers(p.draft, p);
    return html`
      <form
        class="composer-wrap"
        data-composer="openwebui"
        @submit=${p.onSubmit}
        @input=${(e: Event) => onFormInput(e, p)}
      >
        ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${p.attachments} ${p.textarea}
        <div class="composer-toolbar">
          <div class="composer-left">${p.fileInput} ${actionsMenu(p)} ${mentionsMenu(p)} ${modelMenu(p)}</div>
          <div class="composer-right">
            ${p.defaultButtons}
            <button
              class="owui-round owui-mic"
              type="button"
              aria-label="Voice input"
              aria-disabled="true"
              ${tip("Voice input is not available here")}
            >
              ${icon(Mic, 18)}
            </button>
            ${sendButton(p)}
          </div>
        </div>
        ${p.notice}
      </form>
      ${p.pasteDialog}
    `;
  },
  topbar: (p) => {
    const open = p.menu.open === "picker";
    return html`<div class="menu-control owui-picker" data-align="left" data-drop="down">
      <button
        class="owui-picker-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-picker-menu"
        ?disabled=${p.inputBlocked}
        @click=${(e: Event) => p.menu.toggle(e, "picker")}
      >
        <span class="owui-picker-label">${p.models.selected.buttonLabel}</span>
        ${icon(ChevronDown, 16)}
      </button>
      ${open ? modelPanel(p, "picker") : nothing}
    </div>`;
  },
};
