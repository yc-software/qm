import { html, nothing, type TemplateResult } from "lit";
import { ArrowUp, Check, ChevronDown, Image, Plus, Sparkles, Square, Zap } from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts.ts";
import type { ModelOption } from "../model-options.ts";
import { icon } from "../ui.ts";

const swallowClick = (e: Event): void => e.stopPropagation();

const mark = (harnessLabel: string): TemplateResult =>
  html`<span class="beui-mark" aria-hidden="true">${harnessLabel.charAt(0)}</span>`;

function actionsMenu(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "actions";
  const pick = (): void => {
    p.menu.close();
    p.pickFiles();
  };
  const workflow = (): void => {
    p.menu.close();
    p.insertText("/");
  };
  return html`
    <div class="menu-control beui-actions" data-align="left" data-drop="up">
      <button
        class="beui-plus"
        type="button"
        aria-label=${open ? "Close actions" : "Add to your message"}
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
          ? html`
              <div class="menu-popover beui-popover" id="composer-actions-menu" role="menu" @click=${swallowClick}>
                <button
                  class="menu-option beui-action"
                  type="button"
                  role="menuitem"
                  ?disabled=${p.attachingDisabled}
                  @click=${pick}
                >
                  ${icon(Image, 16)}
                  <span class="menu-option-copy">
                    <span class="menu-option-label">Add a screenshot or visual reference</span>
                    <span class="beui-desc">Attach images or files from your device</span>
                  </span>
                </button>
                <button class="menu-option beui-action" type="button" role="menuitem" @click=${workflow}>
                  ${icon(Sparkles, 16)}
                  <span class="menu-option-copy">
                    <span class="menu-option-label">Give the agent a specialized workflow</span>
                    <span class="beui-desc">Start a slash command to pick a skill</span>
                  </span>
                </button>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function modelRow(p: ComposerParts, option: ModelOption): TemplateResult {
  const active = option.value === p.models.selected.value;
  return html`
    <button
      class="menu-option beui-model-row ${active ? "active" : ""}"
      type="button"
      role="menuitemradio"
      aria-checked=${active ? "true" : "false"}
      @click=${() => p.models.select(option.value)}
    >
      ${mark(option.harnessLabel)}
      <span class="menu-option-copy">
        <span class="menu-option-label">${option.label}</span>
      </span>
      ${active ? icon(Check, 15) : nothing}
    </button>
  `;
}

function effortFooter(p: ComposerParts): TemplateResult {
  return html`
    <div class="beui-footer">
      <span class="beui-footer-label">Effort</span>
      <div class="settings-seg" role="group" aria-label="Effort">
        ${p.effort.levels.map(
          (level) => html`
            <button
              class="settings-chip ${level.value === p.effort.level ? "active" : ""}"
              type="button"
              aria-pressed=${level.value === p.effort.level ? "true" : "false"}
              @click=${() => p.effort.select(level.value)}
            >
              ${level.label}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function fastFooter(p: ComposerParts): TemplateResult {
  return html`
    <button
      class="beui-footer beui-switch-row"
      type="button"
      role="menuitemcheckbox"
      aria-checked=${p.fast.on ? "true" : "false"}
      ?disabled=${!p.fast.available}
      @click=${p.fast.toggle}
    >
      ${icon(Zap, 14)}
      <span class="beui-footer-label">Fast</span>
      <span class="beui-switch" aria-hidden="true"></span>
    </button>
  `;
}

function modelMenu(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "model";
  const selected = p.models.selected;
  const forHarness = (harnessId: string): ModelOption[] => p.models.all.filter((o) => o.harnessId === harnessId);
  const others = p.models.harnesses.filter((h) => h.value !== selected.harnessId);
  return html`
    <div class="menu-control beui-model" data-align="right" data-drop="up">
      <button
        class="menu-button beui-select"
        type="button"
        aria-label="Model: ${selected.label}"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-model-menu"
        ?disabled=${p.inputBlocked}
        @click=${(e: Event) => p.menu.toggle(e, "model")}
      >
        ${mark(selected.harnessLabel)}
        <span class="menu-label">${selected.buttonLabel}</span>
        ${icon(ChevronDown, 14)}
      </button>
      ${
        open
          ? html`
              <div class="menu-popover beui-popover" id="composer-model-menu" role="menu" @click=${swallowClick}>
                <div class="menu-group-label">${selected.harnessLabel}</div>
                ${forHarness(selected.harnessId).map((option) => modelRow(p, option))}
                ${others.map(
                  (harness) => html`
                    <div class="menu-group-label">${harness.label}</div>
                    ${forHarness(harness.value).map((option) => modelRow(p, option))}
                  `,
                )}
                ${p.effort.available ? effortFooter(p) : nothing} ${p.fast.supported ? fastFooter(p) : nothing}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function sendButton(p: ComposerParts): TemplateResult {
  const streaming = p.send.streaming;
  return html`
    <button
      class="beui-send ${streaming ? "streaming" : ""}"
      type=${streaming ? "button" : "submit"}
      aria-label=${streaming ? "Stop" : "Send"}
      ?disabled=${!streaming && !p.send.canSend}
      @click=${streaming ? p.send.stop : nothing}
    >
      <span class="beui-glyph beui-glyph-send">${icon(ArrowUp, 18)}</span>
      <span class="beui-glyph beui-glyph-stop">${icon(Square, 14)}</span>
    </button>
  `;
}

export const beui: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="beui" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${p.attachments} ${p.textarea}
      <div class="composer-toolbar">
        <div class="composer-left">${p.fileInput} ${actionsMenu(p)}</div>
        <div class="composer-right">${modelMenu(p)} ${sendButton(p)}</div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
