import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { AtSign, Check, ChevronDown, Mic, Paperclip, Slash, Zap } from "lucide";
import type { ComposerParts, ComposerVariantModule, Tpl } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const SYSTEM_TOKENS = 1500;
const HOT_SHARE = 0.85;
const RING_RADIUS = 9.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const WAVE_BARS = Array.from({ length: 20 }, (_, i) => i);

let voiceStartedAt = 0;
let voiceTimer: ReturnType<typeof setInterval> | undefined;

function syncVoiceTimer(p: ComposerParts, open: boolean): void {
  if (open && voiceTimer === undefined) {
    voiceStartedAt = Date.now();
    voiceTimer = setInterval(() => p.redraw(), 1000);
  } else if (!open && voiceTimer !== undefined) {
    clearInterval(voiceTimer);
    voiceTimer = undefined;
  }
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function kilo(tokens: number): string {
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function capabilities(model: ModelOption["model"]): string[] {
  return [
    model.input.includes("image") ? "Vision" : "",
    model.reasoning ? "Reasoning" : "",
    `${Math.round(model.contextWindow / 1000)}K`,
  ].filter(Boolean);
}

function popover(p: ComposerParts, kind: string, body: TemplateResult): Tpl {
  if (p.menu.open !== kind) return nothing;
  return html`<div
    class="menu-popover"
    id="composer-${kind}-menu"
    role="menu"
    @click=${(e: Event) => e.stopPropagation()}
  >
    ${body}
  </div>`;
}

function modelRow(
  p: ComposerParts,
  option: ModelOption,
  label: TemplateResult,
  caps: Tpl | TemplateResult[],
): TemplateResult {
  const active = option.value === p.models.selected.value;
  return html`<button
    class="menu-option ${active ? "active" : ""}"
    type="button"
    role="menuitemradio"
    aria-checked=${active ? "true" : "false"}
    @click=${() => p.models.select(option.value)}
  >
    <span class="menu-option-copy">
      ${label}
      <span class="au-meta">${option.model.provider}</span>
    </span>
    <span class="au-caps">${caps} ${active ? icon(Check, 15) : nothing}</span>
  </button>`;
}

function mentions(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "mentions";
  return html`<div class="menu-control" data-align="left" data-drop="up">
    <button
      class="icon-btn"
      type="button"
      aria-label="Mention a model"
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-controls="composer-mentions-menu"
      ?disabled=${p.inputBlocked}
      @click=${(e: Event) => p.menu.toggle(e, "mentions")}
    >
      ${icon(AtSign, 16)}
    </button>
    ${popover(
      p,
      "mentions",
      html`<div class="menu-title">Mention</div>
        ${p.models.all.map((option) =>
          modelRow(p, option, html`<span class="menu-option-label au-handle">@${option.model.id}</span>`, nothing),
        )}`,
    )}
  </div>`;
}

function modelSelector(p: ComposerParts): TemplateResult {
  const open = p.menu.open === "model";
  const query = p.menu.query.trim().toLocaleLowerCase();
  const matches = p.models.all.filter(
    (option) =>
      !query || `${option.label} ${option.model.provider} ${option.harnessLabel}`.toLocaleLowerCase().includes(query),
  );
  const groups = Map.groupBy(matches, (option) => option.harnessLabel);
  return html`<div class="menu-control model-control" data-align="left" data-drop="up">
    <button
      class="menu-button"
      type="button"
      aria-label="Model: ${p.models.selected.label}"
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-controls="composer-model-menu"
      ?disabled=${p.inputBlocked}
      @click=${(e: Event) => p.menu.toggle(e, "model")}
    >
      <span class="au-mark" aria-hidden="true">${p.models.selected.harnessLabel[0]}</span>
      <span class="menu-label">${p.models.selected.buttonLabel}</span>
      ${icon(ChevronDown, 12)}
    </button>
    ${popover(
      p,
      "model",
      html`<label class="menu-search">
          <span class="sr-only">Search models</span>
          <input
            type="search"
            placeholder="Search models…"
            .value=${live(p.menu.query)}
            @input=${(e: InputEvent) => p.menu.setQuery((e.currentTarget as HTMLInputElement).value, "model")}
          />
        </label>
        ${
          matches.length
            ? [...groups].map(
                ([harness, options]) => html`
                  <div class="menu-group-label">${harness}</div>
                  ${options.map((option) =>
                    modelRow(
                      p,
                      option,
                      html`<span class="menu-option-label">${option.label}</span>`,
                      capabilities(option.model).map((cap) => html`<span class="au-cap">${cap}</span>`),
                    ),
                  )}
                `,
              )
            : html`<div class="menu-empty">No models found</div>`
        }
        <div class="au-menu-foot">
          ${
            p.effort.available
              ? html`<div class="au-effort" role="group" aria-label="Reasoning effort">
                  <span class="au-foot-label">Thinking</span>
                  ${p.effort.levels.map(
                    (level) =>
                      html`<button
                        class="au-chip ${level.value === p.effort.level ? "active" : ""}"
                        type="button"
                        aria-pressed=${level.value === p.effort.level ? "true" : "false"}
                        @click=${() => p.effort.select(level.value)}
                      >
                        ${level.label}
                      </button>`,
                  )}
                </div>`
              : nothing
          }
          ${
            p.fast.supported
              ? html`<button
                  class="au-chip ${p.fast.on ? "active" : ""}"
                  type="button"
                  aria-pressed=${p.fast.on ? "true" : "false"}
                  aria-disabled=${p.fast.available ? "false" : "true"}
                  @click=${() => p.fast.toggle()}
                >
                  ${icon(Zap, 12)} Fast
                </button>`
              : nothing
          }
          ${p.defaultButtons}
        </div>`,
    )}
  </div>`;
}

function contextRing(p: ComposerParts): TemplateResult {
  const draftTokens = Math.round(p.draft.length / 4);
  const used = draftTokens + SYSTEM_TOKENS;
  const window = p.models.selected.model.contextWindow;
  const share = Math.min(1, used / window);
  const percent = Math.round(share * 100);
  return html`<div class="au-ctx">
    <button
      class="au-ring ${share > HOT_SHARE ? "hot" : ""}"
      type="button"
      aria-label="Context used: ${percent}%"
      aria-describedby="composer-context-panel"
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle class="au-ring-track" cx="11" cy="11" r=${RING_RADIUS} />
        <circle
          class="au-ring-fill"
          cx="11"
          cy="11"
          r=${RING_RADIUS}
          stroke-dasharray=${RING_LENGTH}
          stroke-dashoffset=${RING_LENGTH * (1 - share)}
        />
      </svg>
      <span class="au-readout">${percent}%</span>
    </button>
    <div class="au-ctx-panel" id="composer-context-panel" role="tooltip">
      System ${kilo(SYSTEM_TOKENS)} · Draft ${kilo(draftTokens)} · Attachments ${p.attachments === nothing ? 0 : "1+"} ·
      Window ${kilo(window)}
    </div>
  </div>`;
}

function voiceBar(p: ComposerParts): TemplateResult {
  return html`<div class="au-voice" role="status" @click=${(e: Event) => e.stopPropagation()}>
    <div class="au-wave" aria-hidden="true">
      ${WAVE_BARS.map((i) => html`<span class="au-wave-bar" style="--i: ${i}"></span>`)}
    </div>
    <span class="au-voice-label">Listening…</span>
    <span class="au-voice-clock">${clock(Date.now() - voiceStartedAt)}</span>
    <button class="au-end" type="button" @click=${() => p.menu.close()}>End</button>
  </div>`;
}

function toolbar(p: ComposerParts): TemplateResult {
  return html`<div class="composer-toolbar">
    <div class="composer-left">
      ${p.fileInput}
      <button
        class="icon-btn"
        type="button"
        aria-label="Attach files"
        ?disabled=${p.attachingDisabled}
        @click=${() => p.pickFiles()}
      >
        ${icon(Paperclip, 16)}
      </button>
      ${mentions(p)}
      <button
        class="icon-btn"
        type="button"
        aria-label="Commands"
        ?disabled=${p.inputBlocked}
        @click=${() => p.insertText("/")}
      >
        ${icon(Slash, 16)}
      </button>
      ${modelSelector(p)}
    </div>
    <div class="composer-right">
      ${contextRing(p)}
      <button
        class="icon-btn"
        type="button"
        aria-label="Voice input"
        ?disabled=${p.inputBlocked}
        @click=${(e: Event) => p.menu.toggle(e, "voice")}
      >
        ${icon(Mic, 16)}
      </button>
      ${p.sendControls}
    </div>
  </div>`;
}

export const assistantui: ComposerVariantModule = {
  render: (p) => {
    const voice = p.menu.open === "voice";
    syncVoiceTimer(p, voice);
    return html`
      <form class="composer-wrap" data-composer="assistantui" @submit=${p.onSubmit}>
        ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.attachments} ${p.approvals} ${p.textarea}
        ${voice ? html`${p.fileInput} ${voiceBar(p)}` : toolbar(p)} ${p.notice}
      </form>
      ${p.pasteDialog}
    `;
  },
};
