import { html, nothing, type TemplateResult } from "lit";
import { ChevronDown, Paperclip, Sparkles } from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const HINTS = ["Ask anything…", "Draft a plan for…", "Explain this code…"];

function contextLabel(option: ModelOption): string {
  return `${Math.round(option.model.contextWindow / 1000)}K`;
}

function harnessGroups(p: ComposerParts): Array<[string, ModelOption[]]> {
  const groups = new Map<string, ModelOption[]>();
  for (const option of p.models.all)
    groups.set(option.harnessLabel, [...(groups.get(option.harnessLabel) ?? []), option]);
  const selected = p.models.selected.harnessLabel;
  return [...groups].sort(([a], [b]) => Number(b === selected) - Number(a === selected));
}

function switchControl(label: string, on: boolean, disabled: boolean, toggle: () => void): TemplateResult {
  return html`<div class="vovk-setting">
    <span>${label}</span>
    <button
      class="vovk-switch"
      type="button"
      role="switch"
      aria-label=${label}
      aria-checked=${on ? "true" : "false"}
      ?disabled=${disabled}
      @click=${toggle}
    >
      <span></span>
    </button>
  </div>`;
}

function modelSettings(p: ComposerParts): TemplateResult {
  const levels = p.effort.levels;
  const lowest = levels[0]?.value ?? p.effort.level;
  const highest = levels[levels.length - 1]?.value ?? p.effort.level;
  const thinking = p.effort.level !== lowest;
  return html`<div class="vovk-model-settings">
    ${
      p.effort.available
        ? html`<div class="vovk-effort">
            <span>Effort</span>
            <div class="settings-seg vovk-pills" role="group" aria-label="Effort">
              ${levels.map(
                (level) =>
                  html`<button
                    class="settings-chip ${level.value === p.effort.level ? "active" : ""}"
                    type="button"
                    aria-pressed=${level.value === p.effort.level ? "true" : "false"}
                    @click=${() => p.effort.select(level.value)}
                  >
                    ${level.label}
                  </button>`,
              )}
            </div>
          </div>`
        : nothing
    }
    ${switchControl("Fast mode", p.fast.on, !p.fast.available, () => p.fast.toggle())}
    ${switchControl("Thinking", thinking, !p.effort.available, () => p.effort.select(thinking ? lowest : highest))}
  </div>`;
}

function modelRow(p: ComposerParts, option: ModelOption): TemplateResult {
  const active = option.value === p.models.selected.value;
  return html`<div class="vovk-model-row ${active ? "active" : ""}">
    <button
      class="vovk-model-btn"
      type="button"
      role="menuitemradio"
      aria-checked=${active ? "true" : "false"}
      @click=${() => p.models.select(option.value)}
    >
      <span class="vovk-model-name">${option.label}</span>
      <span class="vovk-ctx">${contextLabel(option)}</span>
    </button>
    ${active ? modelSettings(p) : nothing}
  </div>`;
}

function modelControl(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "model";
  const selected = p.models.selected;
  return html`<div class="menu-control vovk-model-control" data-align="left" data-drop="down">
    <button
      class="vovk-chip"
      type="button"
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-controls="composer-model-menu"
      ?disabled=${p.inputBlocked}
      @click=${(e: Event) => p.menu.toggle(e, "model")}
    >
      <span class="vovk-mark" aria-hidden="true">${selected.harnessLabel.slice(0, 1)}</span>
      <span class="menu-label">${selected.buttonLabel}</span>
      <span class="vovk-ctx">${contextLabel(selected)}</span>
      ${icon(ChevronDown, 12)}
    </button>
    ${
      open
        ? html`<div
            class="menu-popover"
            id="composer-model-menu"
            role="menu"
            @click=${(e: Event) => e.stopPropagation()}
          >
            ${harnessGroups(p).map(
              ([label, options]) =>
                html`<div class="menu-group-label">${label}</div>
                  ${options.map((option) => modelRow(p, option))}`,
            )}
          </div>`
        : nothing
    }
  </div>`;
}

export const vovk: ComposerVariantModule = {
  render: (p) => {
    const hinting = !p.draft && !p.inputBlocked && !p.send.streaming;
    return html`
      <form class="composer-wrap" data-composer="vovk" @submit=${p.onSubmit}>
        <div class="vovk-bar" role="toolbar" aria-label="Composer tools">
          <button
            class="icon-btn"
            type="button"
            aria-label="Attach files"
            ?disabled=${p.attachingDisabled}
            @click=${() => p.pickFiles()}
          >
            ${icon(Paperclip, 16)}
          </button>
          <button
            class="icon-btn"
            type="button"
            aria-label="Skills"
            ?disabled=${p.inputBlocked}
            @click=${() => p.insertText("/")}
          >
            ${icon(Sparkles, 16)}
          </button>
          <span class="vovk-divider"></span>
          ${modelControl(p)}
        </div>
        ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${p.attachments}
        <div class="vovk-field ${hinting ? "hinting" : ""}">
          ${p.textarea}
          ${
            hinting
              ? html`<div class="vovk-hint" aria-hidden="true">${HINTS.map((hint) => html`<span>${hint}</span>`)}</div>`
              : nothing
          }
        </div>
        <div class="vovk-foot">
          <div class="vovk-foot-left">${p.fileInput} ${p.defaultButtons}</div>
          <div class="vovk-foot-right">
            <span class="vovk-status" data-state=${p.send.streaming ? "working" : "ready"}>
              <i class="vovk-dot"></i>${p.send.streaming ? "Working…" : "Ready"}
            </span>
            ${p.sendControls}
          </div>
        </div>
        ${p.notice}
      </form>
      ${p.pasteDialog}
    `;
  },
};
