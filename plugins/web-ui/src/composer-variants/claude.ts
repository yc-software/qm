import { html, nothing } from "lit";
import { ArrowUp, Check, ChevronDown, ChevronRight, Paperclip, Plus, SlidersHorizontal, Square, Zap } from "lucide";
import type { ComposerParts, ComposerVariantModule, Tpl } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

let moreModels = false;

function describe(p: ComposerParts, m: ModelOption): string {
  if (m.model.reasoning) return "Most intelligent for complex work";
  if (p.models.supportsFast(m.model.id)) return "Fast responses for everyday tasks";
  return "Balanced for most tasks";
}

function modelRow(p: ComposerParts, m: ModelOption): Tpl {
  const active = m.value === p.models.selected.value;
  return html`
    <button
      class="menu-option ${active ? "active" : ""}"
      type="button"
      role="menuitemradio"
      aria-checked=${active ? "true" : "false"}
      @click=${() => p.models.select(m.value)}
    >
      <span class="menu-option-copy">
        <span class="menu-option-label">${m.label}</span>
        <span class="claude-model-desc">${describe(p, m)}</span>
      </span>
      ${active ? icon(Check, 16) : nothing}
    </button>
  `;
}

function toggleMore(e: Event): void {
  moreModels = !moreModels;
  const button = e.currentTarget as HTMLElement;
  button.setAttribute("aria-expanded", String(moreModels));
  (button.nextElementSibling as HTMLElement).hidden = !moreModels;
}

function moreModelsSection(p: ComposerParts): Tpl {
  const others = p.models.all.filter((m) => m.harnessId !== p.models.selected.harnessId);
  if (!others.length) return nothing;
  const groups = new Map<string, ModelOption[]>();
  for (const m of others) groups.set(m.harnessLabel, [...(groups.get(m.harnessLabel) ?? []), m]);
  return html`
    <div class="claude-divider" role="separator"></div>
    <button
      class="menu-option claude-more"
      type="button"
      aria-expanded=${moreModels ? "true" : "false"}
      @click=${toggleMore}
    >
      <span class="menu-option-label">More models</span>
      ${icon(ChevronRight, 14)}
    </button>
    <div ?hidden=${!moreModels}>
      ${[...groups].map(
        ([label, models]) => html`
          <div class="menu-group-label">${label}</div>
          ${models.map((m) => modelRow(p, m))}
        `,
      )}
    </div>
  `;
}

function thinkingSwitch(p: ComposerParts): Tpl {
  if (!p.effort.available) return nothing;
  const lowest = p.effort.levels[0]!.value;
  const highest = p.effort.levels[p.effort.levels.length - 1]!.value;
  const on = p.effort.level !== lowest;
  return html`
    <div class="claude-thinking">
      <span id="claude-thinking-label">Extended thinking</span>
      ${on ? html`<span class="claude-thinking-level">${p.effort.label}</span>` : nothing}
      <button
        class="claude-switch"
        type="button"
        role="switch"
        aria-checked=${on ? "true" : "false"}
        aria-labelledby="claude-thinking-label"
        @click=${() => p.effort.select(on ? lowest : highest)}
      >
        <span class="claude-switch-knob"></span>
      </button>
    </div>
  `;
}

function modelMenu(p: ComposerParts): Tpl {
  const open = p.menu.open === "model";
  const own = p.models.all.filter((m) => m.harnessId === p.models.selected.harnessId);
  return html`
    <div class="menu-control" data-align="right" data-drop="up">
      <button
        class="claude-model-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-model-menu"
        ?disabled=${p.inputBlocked}
        @click=${(e: Event) => p.menu.toggle(e, "model")}
      >
        <span class="menu-label">${p.models.selected.buttonLabel}</span>
        ${icon(ChevronDown, 14)}
      </button>
      ${
        open
          ? html`
              <div
                class="menu-popover claude-menu claude-model-menu"
                id="composer-model-menu"
                role="menu"
                @click=${(e: Event) => e.stopPropagation()}
              >
                ${own.map((m) => modelRow(p, m))} ${moreModelsSection(p)} ${thinkingSwitch(p)}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function actionsMenu(p: ComposerParts): Tpl {
  const open = p.menu.open === "actions";
  const run = (action: () => void) => () => {
    p.menu.close();
    action();
  };
  return html`
    <div class="menu-control" data-align="left" data-drop="up">
      <button
        class="claude-ghost"
        type="button"
        aria-label="Add"
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
          ? html`
              <div
                class="menu-popover claude-menu"
                id="composer-actions-menu"
                role="menu"
                @click=${(e: Event) => e.stopPropagation()}
              >
                <button
                  class="menu-option"
                  type="button"
                  role="menuitem"
                  ?disabled=${p.attachingDisabled}
                  @click=${run(() => p.pickFiles())}
                >
                  <span class="menu-option-label">${icon(Paperclip, 15)} Upload a file</span>
                </button>
                <button class="menu-option" type="button" role="menuitem" @click=${run(() => p.insertText("/"))}>
                  <span class="menu-option-label">${icon(Zap, 15)} Use a skill</span>
                </button>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function toolsMenu(p: ComposerParts): Tpl {
  const open = p.menu.open === "tools";
  const selected = p.models.selected.harnessId;
  return html`
    <div class="menu-control" data-align="left" data-drop="up">
      <button
        class="claude-ghost"
        type="button"
        aria-label="Tools"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-tools-menu"
        ?disabled=${p.inputBlocked}
        @click=${(e: Event) => p.menu.toggle(e, "tools")}
      >
        ${icon(SlidersHorizontal, 18)}
      </button>
      ${
        open
          ? html`
              <div
                class="menu-popover claude-menu claude-tools-menu"
                id="composer-tools-menu"
                role="menu"
                @click=${(e: Event) => e.stopPropagation()}
              >
                <div class="menu-title">Harness</div>
                <div class="settings-seg" role="group" aria-label="Harness">
                  ${p.models.harnesses.map(
                    (h) => html`
                      <button
                        class="settings-chip ${h.value === selected ? "active" : ""}"
                        type="button"
                        aria-pressed=${h.value === selected ? "true" : "false"}
                        @click=${() => p.models.selectHarness(h.value)}
                      >
                        ${h.label}
                      </button>
                    `,
                  )}
                </div>
                ${
                  p.fast.supported
                    ? html`
                        <button
                          class="menu-option ${p.fast.on ? "active" : ""}"
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked=${p.fast.on ? "true" : "false"}
                          ?disabled=${!p.fast.available}
                          @click=${() => p.fast.toggle()}
                        >
                          <span class="menu-option-label">${icon(Zap, 15)} Fast mode</span>
                          ${p.fast.on ? icon(Check, 16) : nothing}
                        </button>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function sendButton(p: ComposerParts): Tpl {
  if (p.send.streaming)
    return html`
      <button class="claude-send claude-stop" type="button" aria-label="Stop" @click=${() => p.send.stop()}>
        ${icon(Square, 14)}
      </button>
    `;
  return html`
    <button class="claude-send" type="submit" aria-label="Send" ?disabled=${!p.send.canSend}>
      ${icon(ArrowUp, 18)}
    </button>
  `;
}

export const claude: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="claude" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.attachments} ${p.approvals} ${p.textarea}
      <div class="claude-row">
        <div class="claude-row-left">${p.fileInput} ${actionsMenu(p)} ${toolsMenu(p)}</div>
        <div class="claude-row-right">${modelMenu(p)} ${sendButton(p)}</div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
