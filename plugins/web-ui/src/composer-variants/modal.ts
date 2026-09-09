import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Check, ChevronDown, Plus, Search, X } from "lucide";
import type { ComposerParts, ComposerVariantModule, Tpl } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui";

const PANEL_ID = "composer-picker-menu";
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function mark(label: string): TemplateResult {
  return html`<span class="modal-mark" aria-hidden="true">${label.slice(0, 1).toUpperCase()}</span>`;
}

function contextChip(model: ModelOption["model"]): string {
  return `${Math.round(model.contextWindow / 1000)}K context`;
}

function openPicker(p: ComposerParts, e: Event): void {
  const root = (e.currentTarget as Element).closest("form")?.parentElement ?? document;
  p.menu.toggle(e, "picker");
  requestAnimationFrame(() => root.querySelector<HTMLInputElement>(`#${PANEL_ID} input`)?.focus());
}

function onFormKeydown(p: ComposerParts, e: KeyboardEvent): void {
  if (e.key !== "/" || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  openPicker(p, e);
}

function onPanelKeydown(p: ComposerParts, e: KeyboardEvent): void {
  const panel = e.currentTarget as HTMLElement;
  if (e.key === "Escape") {
    e.preventDefault();
    const input = panel.closest(".modal-scrim")?.parentElement?.querySelector<HTMLElement>(".composer-input");
    p.menu.close();
    input?.focus();
    return;
  }
  if (e.key !== "Tab") return;
  const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function chipLabel(p: ComposerParts): string {
  const effort = p.effort.available ? ` · ${p.effort.label}` : "";
  const fast = p.fast.on ? " · Fast" : "";
  return `${p.models.selected.buttonLabel}${effort}${fast}`;
}

function modelRow(p: ComposerParts, option: ModelOption): TemplateResult {
  const selected = option.value === p.models.selected.value;
  return html`
    <button
      class="modal-model"
      type="button"
      role="option"
      aria-selected=${selected ? "true" : "false"}
      @click=${() => p.models.select(option.value)}
    >
      <span class="modal-model-copy">
        <span class="modal-model-name">${option.label}</span>
        <span class="modal-model-provider">${option.groupLabel}</span>
      </span>
      <span class="modal-caps">
        ${option.model.input.includes("image") ? html`<span class="modal-cap">Vision</span>` : nothing}
        ${option.model.reasoning ? html`<span class="modal-cap">Reasoning</span>` : nothing}
        <span class="modal-cap">${contextChip(option.model)}</span>
      </span>
      ${selected ? icon(Check, 16) : nothing}
    </button>
  `;
}

function fastField(p: ComposerParts): Tpl {
  if (!p.fast.supported) return nothing;
  return html`
    <div class="modal-field">
      <span class="modal-field-copy">
        <span class="modal-field-label" id="composer-picker-fast">Fast mode</span>
        ${p.fast.available ? nothing : html`<span class="modal-field-note">Not available for this model</span>`}
      </span>
      <button
        class="modal-switch"
        type="button"
        role="switch"
        aria-checked=${p.fast.on ? "true" : "false"}
        aria-labelledby="composer-picker-fast"
        ?disabled=${!p.fast.available || p.inputBlocked}
        @click=${() => p.fast.toggle()}
      >
        <span class="modal-switch-knob"></span>
      </button>
    </div>
  `;
}

function effortField(p: ComposerParts): Tpl {
  if (!p.effort.available) return nothing;
  return html`
    <div class="modal-field modal-effort">
      <span class="modal-field-label" id="composer-picker-effort">Thinking effort</span>
      <div class="modal-segments" role="radiogroup" aria-labelledby="composer-picker-effort">
        ${p.effort.levels.map(
          (level) => html`
            <button
              class="modal-segment"
              type="button"
              role="radio"
              aria-checked=${level.value === p.effort.level ? "true" : "false"}
              ?disabled=${p.inputBlocked}
              @click=${() => p.effort.select(level.value)}
            >
              ${level.label} ${level.value === p.effort.level ? icon(Check, 14) : nothing}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function picker(p: ComposerParts): Tpl {
  if (p.menu.open !== "picker") return nothing;
  const selected = p.models.selected;
  const query = p.menu.query.trim().toLocaleLowerCase();
  const models = p.models.all.filter(
    (option) =>
      option.harnessId === selected.harnessId &&
      (!query || `${option.label} ${option.groupLabel}`.toLocaleLowerCase().includes(query)),
  );
  return html`
    <div class="modal-scrim" @click=${() => p.menu.close()}>
      <div
        class="modal-panel"
        id=${PANEL_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Model and speed"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => onPanelKeydown(p, e)}
      >
        <div class="modal-head">
          <h2 class="modal-title">Model and speed</h2>
          <kbd class="modal-hint">⌘/</kbd>
          <button class="icon-btn" type="button" aria-label="Close" @click=${() => p.menu.close()}>
            ${icon(X, 16)}
          </button>
        </div>
        <div class="modal-body">
          <div class="modal-rail" role="group" aria-label="Harness">
            ${p.models.harnesses.map(
              (harness) => html`
                <button
                  class="modal-harness"
                  type="button"
                  aria-pressed=${harness.value === selected.harnessId ? "true" : "false"}
                  @click=${() => p.models.selectHarness(harness.value)}
                >
                  ${mark(harness.label)}
                  <span class="modal-harness-label">${harness.label}</span>
                </button>
              `,
            )}
          </div>
          <div class="modal-list">
            <label class="modal-search">
              <span class="sr-only">Search models</span>
              ${icon(Search, 14)}
              <input
                type="search"
                placeholder="Search models…"
                .value=${live(p.menu.query)}
                @input=${(e: InputEvent) => p.menu.setQuery((e.currentTarget as HTMLInputElement).value, "picker")}
              />
            </label>
            <div class="modal-models" role="listbox" aria-label="Models">
              ${models.length ? models.map((option) => modelRow(p, option)) : html`<div class="menu-empty">No models found</div>`}
            </div>
          </div>
          <div class="modal-detail">
            <div>
              <div class="modal-detail-name">${selected.label}</div>
              <div class="modal-detail-desc">
                ${selected.harnessLabel} · ${selected.groupLabel} · ${contextChip(selected.model)}
              </div>
            </div>
            ${fastField(p)} ${effortField(p)}
            <div class="modal-defaults">${p.defaultButtons}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export const modal: ComposerVariantModule = {
  render: (p) => html`
    <form
      class="composer-wrap"
      data-composer="modal"
      @submit=${p.onSubmit}
      @keydown=${(e: KeyboardEvent) => onFormKeydown(p, e)}
    >
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.attachments} ${p.approvals} ${p.textarea}
      <div class="composer-toolbar">
        <div class="composer-left">
          ${p.fileInput}
          <button
            class="icon-btn"
            type="button"
            aria-label="Attach files"
            ?disabled=${p.attachingDisabled}
            @click=${() => p.pickFiles()}
          >
            ${icon(Plus, 16)}
          </button>
        </div>
        <div class="composer-right">
          <div class="menu-control modal-control">
            <button
              class="modal-chip"
              type="button"
              aria-haspopup="dialog"
              aria-expanded=${p.menu.open === "picker" ? "true" : "false"}
              aria-controls=${PANEL_ID}
              ?disabled=${p.inputBlocked}
              @click=${(e: Event) => openPicker(p, e)}
            >
              ${mark(p.models.selected.harnessLabel)}
              <span class="modal-chip-label">${chipLabel(p)}</span>
              ${icon(ChevronDown, 12)}
            </button>
          </div>
          ${p.sendControls}
        </div>
      </div>
      ${p.notice}
    </form>
    ${picker(p)} ${p.pasteDialog}
  `,
};
