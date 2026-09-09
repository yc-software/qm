import { html, nothing, type TemplateResult } from "lit";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Square,
  SquareSlash,
  Telescope,
  type IconNode,
} from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const stop = (e: Event): void => e.stopPropagation();

function describe(option: ModelOption): string {
  if (option.model.reasoning) return "Advanced reasoning";
  if (option.model.input.includes("image")) return "Handles images";
  return "Fast, everyday model";
}

function modeControl(p: ComposerParts): TemplateResult {
  const levels = p.effort.levels;
  const lowest = levels[0]?.value ?? p.effort.level;
  const highest = levels[levels.length - 1]?.value ?? p.effort.level;
  const research = p.effort.level === highest;
  const segment = (label: string, glyph: IconNode, active: boolean, level: string): TemplateResult => html`
    <button
      class="pplx-seg ${active ? "active" : ""}"
      type="button"
      role="radio"
      aria-checked=${active ? "true" : "false"}
      ?disabled=${!p.effort.available}
      @click=${() => p.effort.select(level)}
    >
      ${icon(glyph, 14)}<span>${label}</span>
    </button>
  `;
  return html`
    <div class="pplx-mode" role="radiogroup" aria-label="Mode">
      ${segment("Search", Search, !research, lowest)} ${segment("Research", Telescope, research, highest)}
    </div>
  `;
}

function modelRow(p: ComposerParts, option: ModelOption): TemplateResult {
  const active = option.value === p.models.selected.value;
  return html`
    <button
      class="pplx-model-row ${active ? "active" : ""}"
      type="button"
      role="menuitemradio"
      aria-checked=${active ? "true" : "false"}
      @click=${() => p.models.select(option.value)}
    >
      <span class="pplx-radio"></span>
      <span class="pplx-model-copy">
        <span class="pplx-model-head">
          <span class="pplx-model-name">${option.label}</span>
          ${option.model.reasoning ? html`<span class="pplx-pro">Pro</span>` : nothing}
        </span>
        <span class="pplx-model-desc">${describe(option)}</span>
      </span>
      ${active ? icon(Check, 14) : nothing}
    </button>
  `;
}

function modelMenu(p: ComposerParts): TemplateResult {
  const harnessId = p.models.selected.harnessId;
  const own = p.models.all.filter((m) => m.harnessId === harnessId);
  const others = new Map<string, ModelOption[]>();
  for (const m of p.models.all) {
    if (m.harnessId !== harnessId) others.set(m.harnessId, [...(others.get(m.harnessId) ?? []), m]);
  }
  return html`
    <div class="menu-popover pplx-models" id="composer-model-menu" role="menu" @click=${stop}>
      <div class="menu-title">Choose a model</div>
      <button
        class="pplx-model-row"
        type="button"
        role="menuitem"
        @click=${() => p.models.select(own[0]?.value ?? p.models.selected.value)}
      >
        <span class="pplx-radio"></span>
        <span class="pplx-model-copy">
          <span class="pplx-model-head"><span class="pplx-model-name">Best</span></span>
          <span class="pplx-model-desc">Picks the right model for each query</span>
        </span>
      </button>
      ${own.map((m) => modelRow(p, m))}
      ${[...others.values()].map(
        (group) => html`
          <div class="pplx-divider" role="separator"></div>
          <div class="menu-group-label">${group[0]!.harnessLabel}</div>
          ${group.map((m) => modelRow(p, m))}
        `,
      )}
    </div>
  `;
}

function actionsMenu(p: ComposerParts): TemplateResult {
  const run = (action: () => void) => () => {
    p.menu.close();
    action();
  };
  return html`
    <div class="menu-popover pplx-actions" id="composer-actions-menu" role="menu" @click=${stop}>
      <button
        class="menu-option"
        type="button"
        role="menuitem"
        ?disabled=${p.attachingDisabled}
        @click=${run(() => p.pickFiles())}
      >
        ${icon(Paperclip, 14)}<span class="menu-option-label">Attach files</span>
      </button>
      <button class="menu-option" type="button" role="menuitem" @click=${run(() => p.insertText("/"))}>
        ${icon(SquareSlash, 14)}<span class="menu-option-label">Use a skill</span>
      </button>
    </div>
  `;
}

function sendButton(p: ComposerParts): TemplateResult {
  if (p.send.streaming) {
    return html`
      <button class="stop-btn pplx-send" type="button" aria-label="Stop" @click=${() => p.send.stop()}>
        ${icon(Square, 12)}
      </button>
    `;
  }
  return html`
    <button class="send-btn pplx-send" type="submit" aria-label="Send" ?disabled=${!p.send.canSend}>
      ${icon(ArrowRight, 18)}
    </button>
  `;
}

export const perplexity: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="perplexity" @submit=${p.onSubmit}>
      ${p.header} ${p.upgradeNotice} ${p.slashMenu} ${p.attachments} ${p.approvals} ${p.textarea} ${p.fileInput}
      <div class="pplx-row">
        ${modeControl(p)}
        <div class="pplx-tools">
          <div class="menu-control" data-align="left" data-drop="up">
            <button
              class="icon-btn pplx-plus"
              type="button"
              aria-label="Add"
              aria-haspopup="menu"
              aria-expanded=${p.menu.open === "actions" ? "true" : "false"}
              aria-controls="composer-actions-menu"
              @click=${(e: Event) => p.menu.toggle(e, "actions")}
            >
              ${icon(Plus, 18)}
            </button>
            ${p.menu.open === "actions" ? actionsMenu(p) : nothing}
          </div>
          <div class="menu-control" data-align="right" data-drop="up">
            <button
              class="menu-button pplx-model"
              type="button"
              aria-haspopup="menu"
              aria-expanded=${p.menu.open === "model" ? "true" : "false"}
              aria-controls="composer-model-menu"
              @click=${(e: Event) => p.menu.toggle(e, "model")}
            >
              ${icon(Sparkles, 14)}
              <span class="menu-label">${p.models.selected.buttonLabel}</span>
              ${icon(ChevronDown, 12)}
            </button>
            ${p.menu.open === "model" ? modelMenu(p) : nothing}
          </div>
          ${sendButton(p)}
        </div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
