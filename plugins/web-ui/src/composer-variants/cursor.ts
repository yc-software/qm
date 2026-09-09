import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import {
  ArrowUp,
  AtSign,
  Brain,
  Check,
  ChevronDown,
  Image,
  Infinity as InfinityIcon,
  MessageSquare,
  Pencil,
  Square,
  type IconNode,
} from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const MODES: ReadonlyArray<{ id: string; label: string; glyph: IconNode; hint: string; kbd: string }> = [
  { id: "agent", label: "Agent", glyph: InfinityIcon, hint: "Plans, edits files and runs commands", kbd: "⌘I" },
  { id: "ask", label: "Ask", glyph: MessageSquare, hint: "Answers questions without editing", kbd: "⌘L" },
  { id: "manual", label: "Manual", glyph: Pencil, hint: "Edits only what you point at", kbd: "⌘K" },
];

let mode = MODES[0]!;

function modeMenu(p: ComposerParts) {
  const open = p.menu.open === "mode";
  return html`
    <div class="menu-control cursor-mode" data-align="left" data-drop="up">
      <button
        class="menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-mode-menu"
        @click=${(e: Event) => p.menu.toggle(e, "mode")}
      >
        ${icon(mode.glyph, 12)}
        <span class="menu-label">${mode.label}</span>
        ${icon(ChevronDown, 10)}
      </button>
      ${
        open
          ? html`<div
              class="menu-popover"
              id="composer-mode-menu"
              role="menu"
              @click=${(e: Event) => e.stopPropagation()}
            >
              ${MODES.map(
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
                    ${icon(m.glyph, 13)}
                    <span class="menu-option-copy">
                      <span class="menu-option-label">${m.label}</span>
                      <span class="cursor-hint">${m.hint}</span>
                    </span>
                    <kbd>${m.kbd}</kbd>
                  </button>
                `,
              )}
            </div>`
          : nothing
      }
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
      <span class="menu-option-label cursor-mono">${option.model.id}</span>
      ${option.model.contextWindow >= 1_000_000 ? html`<span class="cursor-max">MAX</span>` : nothing}
      ${option.model.reasoning ? icon(Brain, 12) : nothing}
      <span class="cursor-spacer"></span>
      ${selected ? icon(Check, 13) : nothing}
    </button>
  `;
}

function modelMenu(p: ComposerParts) {
  const open = p.menu.open === "model";
  const selected = p.models.selected;
  const first = p.models.all.find((m) => m.harnessId === selected.harnessId) ?? selected;
  const auto = first.value === selected.value;
  const query = p.menu.query.trim().toLocaleLowerCase();
  const matches = p.models.all.filter(
    (m) => !query || `${m.model.id} ${m.label} ${m.harnessLabel}`.toLocaleLowerCase().includes(query),
  );
  const own = matches.filter((m) => m.harnessId === selected.harnessId);
  const others = new Map<string, ModelOption[]>();
  for (const m of matches) {
    if (m.harnessId === selected.harnessId) continue;
    others.set(m.harnessLabel, [...(others.get(m.harnessLabel) ?? []), m]);
  }
  return html`
    <div class="menu-control cursor-model" data-align="left" data-drop="up">
      <button
        class="menu-button cursor-mono"
        type="button"
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-model-menu"
        @click=${(e: Event) => p.menu.toggle(e, "model")}
      >
        <span class="menu-label">${selected.model.id}</span>
        ${icon(ChevronDown, 10)}
      </button>
      ${
        open
          ? html`<div
              class="menu-popover"
              id="composer-model-menu"
              role="menu"
              @click=${(e: Event) => e.stopPropagation()}
            >
              <div class="cursor-auto">
                <span>Auto</span>
                <button
                  class="cursor-switch"
                  type="button"
                  role="switch"
                  aria-label="Auto"
                  aria-checked=${auto ? "true" : "false"}
                  @click=${() => {
                    if (!auto) p.models.select(first.value);
                  }}
                ></button>
              </div>
              <label class="menu-search">
                <input
                  type="search"
                  placeholder="Search models"
                  aria-label="Search models"
                  .value=${live(p.menu.query)}
                  @input=${(e: InputEvent) => p.menu.setQuery((e.currentTarget as HTMLInputElement).value, "model")}
                />
              </label>
              ${own.map((m) => modelRow(p, m))}
              ${[...others].map(
                ([label, options]) => html`
                  <div class="menu-group-label">${label}</div>
                  ${options.map((m) => modelRow(p, m))}
                `,
              )}
              ${matches.length ? nothing : html`<div class="menu-empty">No models found</div>`}
              ${
                p.effort.available
                  ? html`<div class="cursor-effort" role="group" aria-label="Reasoning effort">
                      ${p.effort.levels.map(
                        (level) => html`
                          <button
                            class="cursor-pill ${level.value === p.effort.level ? "active" : ""}"
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
            </div>`
          : nothing
      }
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

export const cursor: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="cursor" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice}
      <div class="cursor-context">
        <button class="cursor-add-context" type="button" ?disabled=${p.inputBlocked} @click=${() => p.insertText("@")}>
          ${icon(AtSign, 11)} Add context
        </button>
        ${p.attachments}
      </div>
      ${p.approvals} ${p.textarea}
      <div class="composer-toolbar">
        <div class="composer-left">${p.fileInput} ${modeMenu(p)} ${modelMenu(p)}</div>
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
          ${p.send.streaming ? nothing : html`<kbd class="cursor-kbd">⌘↵</kbd>`} ${sendButton(p)}
        </div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
