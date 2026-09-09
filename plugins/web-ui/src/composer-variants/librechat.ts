import { html, nothing, type TemplateResult } from "lit";
import { Check, ChevronDown, Mic, Paperclip, Plus, Slash, Wrench, Zap } from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { tip } from "../tooltip.ts";
import { icon } from "../ui.ts";

const mark = (label: string): string => label.trim().charAt(0).toUpperCase();

function byHarness(options: ModelOption[]): Array<{ label: string; options: ModelOption[] }> {
  const groups = new Map<string, ModelOption[]>();
  for (const option of options) groups.set(option.harnessLabel, [...(groups.get(option.harnessLabel) ?? []), option]);
  return [...groups].map(([label, grouped]) => ({ label, options: grouped }));
}

function trigger(
  p: ComposerParts,
  kind: string,
  className: string,
  title: string,
  body: unknown,
  disabled: boolean,
): TemplateResult {
  const open = p.menu.open === kind;
  return html`<button
    class=${className}
    type="button"
    ${tip(title)}
    aria-label=${title}
    aria-haspopup="menu"
    aria-expanded=${open ? "true" : "false"}
    aria-controls=${`composer-${kind}-menu`}
    ?disabled=${disabled}
    @click=${(e: Event) => p.menu.toggle(e, kind)}
  >
    ${body}
  </button>`;
}

function menu(p: ComposerParts, kind: string, control: TemplateResult, body: TemplateResult): TemplateResult {
  const open = p.menu.open === kind;
  return html`<div class="menu-control lc-menu ${open ? "open" : ""}" data-align="left" data-drop="up">
    ${control}
    ${
      open
        ? html`<div
            class="menu-popover"
            id=${`composer-${kind}-menu`}
            role="menu"
            @click=${(e: Event) => e.stopPropagation()}
          >
            ${body}
          </div>`
        : nothing
    }
  </div>`;
}

function row(active: boolean, pick: () => void, copy: TemplateResult): TemplateResult {
  return html`<button
    class="menu-option ${active ? "active" : ""}"
    type="button"
    role="menuitemradio"
    aria-checked=${active ? "true" : "false"}
    @click=${pick}
  >
    <span class="menu-option-copy">${copy}</span>
    ${active ? icon(Check, 15) : nothing}
  </button>`;
}

function modelMenu(p: ComposerParts): TemplateResult {
  const selected = p.models.selected;
  const chip = trigger(
    p,
    "model",
    "lc-chip lc-spec",
    `Model: ${selected.buttonLabel}`,
    html`<span class="lc-mark" aria-hidden="true">${mark(selected.harnessLabel)}</span>
      <span class="lc-chip-label">${selected.buttonLabel}</span>
      ${icon(ChevronDown, 12)}`,
    p.inputBlocked,
  );
  const body = html`
    ${byHarness(p.models.all).map(
      (group) => html`
        <div class="menu-group-label">${group.label}</div>
        ${group.options.map((option) =>
          row(
            option.value === selected.value,
            () => p.models.select(option.value),
            html`<span class="menu-option-label">${option.label}</span>
              <span class="lc-desc">${option.groupLabel} · ${option.model.id}</span>`,
          ),
        )}
      `,
    )}
    ${
      p.effort.available
        ? html`<div class="lc-foot" role="group" aria-label="Effort">
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
          </div>`
        : nothing
    }
  `;
  return menu(p, "model", chip, body);
}

function toolsMenu(p: ComposerParts): TemplateResult {
  const active = (p.fast.on ? 1 : 0) + (p.effort.available ? 1 : 0);
  const chip = trigger(
    p,
    "tools",
    "lc-chip lc-tools",
    `Tools: ${active} active`,
    html`${icon(Wrench, 14)}<span class="lc-chip-label">Tools</span
      ><span class="lc-count">${active}</span>${icon(ChevronDown, 12)}`,
    p.inputBlocked,
  );
  const body = html`
    <div class="menu-title">Capabilities</div>
    <button
      class="menu-option lc-switch-row"
      type="button"
      role="switch"
      aria-checked=${p.fast.on ? "true" : "false"}
      ?disabled=${!p.fast.available}
      @click=${() => p.fast.toggle()}
    >
      <span class="menu-option-copy">
        <span class="menu-option-label">${icon(Zap, 13)} Fast mode</span>
        ${p.fast.available ? nothing : html`<span class="lc-desc">Not offered by this model</span>`}
      </span>
      <span class="lc-switch" aria-hidden="true"></span>
    </button>
    <div class="menu-title">Harness</div>
    ${p.models.harnesses.map((harness) =>
      row(
        harness.value === p.models.selected.harnessId,
        () => p.models.selectHarness(harness.value),
        html`<span class="menu-option-label"
          ><span class="lc-mark" aria-hidden="true">${mark(harness.label)}</span>${harness.label}</span
        >`,
      ),
    )}
  `;
  return menu(p, "tools", chip, body);
}

function actionsMenu(p: ComposerParts): TemplateResult {
  const body = html`
    <button
      class="menu-option lc-action"
      type="button"
      role="menuitem"
      ?disabled=${p.attachingDisabled}
      @click=${() => {
        p.menu.close();
        p.pickFiles();
      }}
    >
      ${icon(Paperclip, 15)}<span>Attach files</span>
    </button>
    <button
      class="menu-option lc-action"
      type="button"
      role="menuitem"
      @click=${() => {
        p.menu.close();
        p.insertText("/");
      }}
    >
      ${icon(Slash, 15)}<span>Use a skill</span>
    </button>
  `;
  return menu(p, "actions", trigger(p, "actions", "lc-round", "Add", icon(Plus, 18), p.inputBlocked), body);
}

export const librechat: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="librechat" @submit=${p.onSubmit}>
      ${p.header}
      ${
        p.approvals === nothing
          ? nothing
          : html`<div class="lc-tray">
              <div class="lc-tray-head">Review pending actions</div>
              ${p.approvals}
            </div>`
      }
      ${p.upgradeNotice} ${p.attachments}
      <div class="lc-top">${modelMenu(p)} ${toolsMenu(p)} ${p.defaultButtons}</div>
      ${p.slashMenu} ${p.textarea} ${p.notice}
      <div class="composer-toolbar lc-bottom">
        <div class="composer-left">${p.fileInput} ${actionsMenu(p)}</div>
        <div class="composer-right">
          <span class="lc-mic" ${tip("Voice input is not available here")}
            ><button class="lc-round" type="button" aria-label="Voice input" disabled>${icon(Mic, 18)}</button></span
          >
          ${p.sendControls}
        </div>
      </div>
    </form>
    ${p.pasteDialog}
  `,
};
