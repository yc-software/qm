import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowUp, AtSign, Check, ChevronDown, Paperclip, Square } from "lucide";
import type { ComposerParts, ComposerVariantModule, Tpl } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { tip } from "../tooltip.ts";
import { icon } from "../ui.ts";

const RECOMMENDED_LIMIT = 4;

function describe(p: ComposerParts, option: ModelOption): string {
  if (option.model.reasoning) return "Best for complex, multi-step work";
  if (p.models.supportsFast(option.model.id)) return "Quick and inexpensive";
  return "Solid all-rounder";
}

function isRecommended(p: ComposerParts, option: ModelOption): boolean {
  return option.model.reasoning || p.models.all.find((o) => o.harnessId === option.harnessId) === option;
}

function modelRow(p: ComposerParts, option: ModelOption, description: string | null): TemplateResult {
  const selected = option.value === p.models.selected.value;
  return html`<button
    class="menu-option ${description ? "cline-pick" : ""} ${selected ? "active" : ""}"
    type="button"
    role="menuitemradio"
    aria-checked=${selected ? "true" : "false"}
    @click=${() => p.models.select(option.value)}
  >
    <span class="menu-option-copy">
      <span class="menu-option-label">${option.label}</span>
      ${description ? html`<span class="cline-pick-desc">${description}</span>` : nothing}
    </span>
    ${selected ? icon(Check, 14) : nothing}
  </button>`;
}

function modelMenu(p: ComposerParts): TemplateResult {
  const query = p.menu.query.trim().toLocaleLowerCase();
  const visible = p.models.all.filter(
    (o) => !query || `${o.label} ${o.harnessLabel}`.toLocaleLowerCase().includes(query),
  );
  const picks = visible
    .filter((o) => o.harnessId === p.models.selected.harnessId && o.model.reasoning)
    .slice(0, RECOMMENDED_LIMIT);
  const groups = p.models.harnesses
    .map((h) => ({ label: h.label, options: visible.filter((o) => o.harnessId === h.value) }))
    .filter((g) => g.options.length);
  return html`<div
    class="menu-popover"
    id="composer-model-menu"
    role="menu"
    @click=${(e: Event) => e.stopPropagation()}
  >
    <label class="menu-search">
      <input
        type="search"
        aria-label="Search models"
        placeholder="Search models…"
        .value=${live(p.menu.query)}
        @input=${(e: InputEvent) => p.menu.setQuery((e.currentTarget as HTMLInputElement).value, "model")}
      />
    </label>
    ${
      picks.length
        ? html`<div class="menu-title">Recommended</div>
            ${picks.map((o) => modelRow(p, o, describe(p, o)))}`
        : nothing
    }
    ${
      groups.length
        ? html`<div class="menu-title">All models</div>
            ${groups.map(
              (g) =>
                html`<div class="menu-group-label">${g.label}</div>
                  ${g.options.map((o) => modelRow(p, o, null))}`,
            )}`
        : html`<div class="menu-empty">No models found</div>`
    }
  </div>`;
}

function modelControl(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "model";
  return html`<div class="menu-control" data-align="right" data-drop="up">
    <button
      class="menu-button"
      type="button"
      ${tip("Model")}
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-controls="composer-model-menu"
      ?disabled=${p.inputBlocked}
      @click=${(e: Event) => p.menu.toggle(e, "model")}
    >
      <span class="menu-label">${p.models.selected.buttonLabel}</span>
      ${isRecommended(p, p.models.selected) ? html`<span class="cline-tier">Recommended</span>` : nothing}
      ${icon(ChevronDown, 12)}
    </button>
    ${open ? modelMenu(p) : nothing}
  </div>`;
}

function modeToggle(p: ComposerParts): Tpl {
  const plan = p.effort.levels[0];
  const act = p.effort.levels[p.effort.levels.length - 1];
  if (!plan || !act) return nothing;
  const segment = (label: string, level: { value: string }): TemplateResult =>
    html`<button
      class="cline-seg"
      type="button"
      aria-pressed=${p.effort.level === level.value ? "true" : "false"}
      ?disabled=${!p.effort.available}
      @click=${() => p.effort.select(level.value)}
    >
      ${label}
    </button>`;
  return html`<div class="cline-mode" role="group" aria-label="Mode">
    ${segment("Plan", plan)} ${segment("Act", act)}
  </div>`;
}

function sendButton(p: ComposerParts): TemplateResult {
  if (p.send.streaming)
    return html`<button
      class="cline-send cline-stop"
      type="button"
      aria-label="Stop"
      ${tip("Stop")}
      @click=${() => p.send.stop()}
    >
      ${icon(Square, 12)}
    </button>`;
  return html`<button class="cline-send" type="submit" aria-label="Send" ${tip("Send")} ?disabled=${!p.send.canSend}>
    ${icon(ArrowUp, 12)}
  </button>`;
}

export const cline: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="cline" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${p.attachments} ${p.textarea}
      <div class="cline-bar">
        <div class="cline-bar-left">
          ${p.fileInput} ${modeToggle(p)}
          <button
            class="icon-btn"
            type="button"
            aria-label="Mention"
            ${tip("Mention a file or resource")}
            ?disabled=${p.inputBlocked}
            @click=${() => p.insertText("@")}
          >
            ${icon(AtSign, 15)}
          </button>
          <button
            class="icon-btn"
            type="button"
            aria-label="Attach files"
            ${tip("Attach files")}
            ?disabled=${p.attachingDisabled}
            @click=${() => p.pickFiles()}
          >
            ${icon(Paperclip, 15)}
          </button>
        </div>
        <div class="cline-bar-right">
          ${modelControl(p)} ${p.send.streaming ? nothing : html`<kbd class="cline-kbd">⌘↵</kbd>`} ${sendButton(p)}
        </div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
