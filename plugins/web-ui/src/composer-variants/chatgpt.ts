import { html, nothing, type TemplateResult } from "lit";
import { ArrowUp, Check, ChevronDown, Paperclip, Plus, Square, SquareSlash } from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui";

function describeModel(p: ComposerParts, option: ModelOption): string {
  if (option.model.reasoning) return "Great for complex reasoning";
  if (p.models.supportsFast(option.model.id)) return "Fastest for quick answers";
  if (option.model.input.includes("image")) return "Great for everyday tasks";
  return "Great for most tasks";
}

function modelRow(p: ComposerParts, option: ModelOption): TemplateResult {
  const active = option.value === p.models.selected.value;
  return html`<button
    class="menu-option ${active ? "active" : ""}"
    type="button"
    role="menuitemradio"
    aria-checked=${active ? "true" : "false"}
    @click=${() => p.models.select(option.value)}
  >
    <span class="menu-option-copy">
      <span class="menu-option-label">${option.label}</span>
      <span class="menu-option-desc">${describeModel(p, option)}</span>
    </span>
    ${active ? icon(Check, 16) : nothing}
  </button>`;
}

function moreModels(p: ComposerParts, others: ModelOption[]): TemplateResult | typeof nothing {
  if (!others.length) return nothing;
  const harnessLabels = [...new Set(others.map((option) => option.harnessLabel))];
  return html`<div class="chatgpt-divider"></div>
    <details class="chatgpt-more">
      <summary class="menu-option">More models ${icon(ChevronDown, 16)}</summary>
      ${harnessLabels.map(
        (label) =>
          html`<div class="menu-group-label">${label}</div>
            ${others.filter((option) => option.harnessLabel === label).map((option) => modelRow(p, option))}`,
      )}
    </details>`;
}

function thinkLonger(p: ComposerParts): TemplateResult | typeof nothing {
  if (!p.effort.available) return nothing;
  return html`<div class="chatgpt-divider"></div>
    <div class="menu-group-label">Think longer</div>
    <div class="chatgpt-effort" role="group" aria-label="Think longer">
      ${p.effort.levels.map(
        (level) =>
          html`<button
            class="chatgpt-pill ${level.value === p.effort.level ? "active" : ""}"
            type="button"
            aria-pressed=${level.value === p.effort.level ? "true" : "false"}
            @click=${() => p.effort.select(level.value)}
          >
            ${level.label}
          </button>`,
      )}
    </div>`;
}

function actionsMenu(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "actions";
  return html`<div class="menu-control" data-align="left" data-drop="up">
    <button
      class="chatgpt-plus"
      type="button"
      aria-label="Add photos, files and more"
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-controls="composer-actions-menu"
      ?disabled=${p.inputBlocked}
      @click=${(e: Event) => p.menu.toggle(e, "actions")}
    >
      ${icon(Plus, 20)}
    </button>
    ${
      open
        ? html`<div
            class="menu-popover"
            id="composer-actions-menu"
            role="menu"
            @click=${(e: Event) => e.stopPropagation()}
          >
            <button
              class="menu-option"
              type="button"
              role="menuitem"
              ?disabled=${p.attachingDisabled}
              @click=${() => {
                p.menu.close();
                p.pickFiles();
              }}
            >
              ${icon(Paperclip, 18)}<span>Add photos & files</span>
            </button>
            <button
              class="menu-option"
              type="button"
              role="menuitem"
              @click=${() => {
                p.menu.close();
                p.insertText("/");
              }}
            >
              ${icon(SquareSlash, 18)}<span>Use a skill</span>
            </button>
          </div>`
        : nothing
    }
  </div>`;
}

function sendButton(p: ComposerParts): TemplateResult {
  if (p.send.streaming)
    return html`<button class="stop-btn" type="button" aria-label="Stop" @click=${() => p.send.stop()}>
      ${icon(Square, 12)}
    </button>`;
  return html`<button class="send-btn" type="submit" aria-label="Send" ?disabled=${!p.send.canSend}>
    ${icon(ArrowUp, 18)}
  </button>`;
}

export const chatgpt: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="chatgpt" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${p.attachments}
      <div class="chatgpt-row">${actionsMenu(p)} ${p.textarea} ${p.fileInput} ${sendButton(p)}</div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
  topbar: (p) => {
    const open = p.menu.open === "picker";
    const selectedHarness = p.models.selected.harnessId;
    const primary = p.models.all.filter((option) => option.harnessId === selectedHarness);
    const others = p.models.all.filter((option) => option.harnessId !== selectedHarness);
    return html`<div class="menu-control" data-composer="chatgpt" data-align="left" data-drop="down">
      <button
        class="menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-picker-menu"
        @click=${(e: Event) => p.menu.toggle(e, "picker")}
      >
        <span class="menu-label">${p.models.selected.buttonLabel}</span>
        ${icon(ChevronDown, 16)}
      </button>
      ${
        open
          ? html`<div
              class="menu-popover"
              id="composer-picker-menu"
              role="menu"
              @click=${(e: Event) => e.stopPropagation()}
            >
              ${primary.map((option) => modelRow(p, option))} ${moreModels(p, others)} ${thinkLonger(p)}
            </div>`
          : nothing
      }
    </div>`;
  },
};
