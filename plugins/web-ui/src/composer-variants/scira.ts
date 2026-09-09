import { html, nothing } from "lit";
import { Check, ChevronDown, Mic, Plus } from "lucide";
import type { ComposerParts, ComposerVariantModule, Tpl } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const BARS = Array.from({ length: 24 }, (_, i) => i);
let mentionArmed = false;
let voiceStart = 0;
let voiceTimer: ReturnType<typeof setInterval> | null = null;

function syncVoiceTimer(p: ComposerParts): void {
  const open = p.menu.open === "voice";
  if (open && voiceTimer === null) {
    voiceStart = Date.now();
    voiceTimer = setInterval(() => p.redraw(), 1000);
  } else if (!open && voiceTimer !== null) {
    clearInterval(voiceTimer);
    voiceTimer = null;
  }
}

function elapsed(): string {
  const total = Math.floor((Date.now() - voiceStart) / 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function describe(m: ModelOption): string {
  const ctx = m.model.contextWindow ? `${Math.round(m.model.contextWindow / 1000)}k context` : "";
  return [m.groupLabel, m.model.reasoning ? "Reasoning" : "Fast answers", ctx].filter(Boolean).join(" · ");
}

function handle(m: ModelOption): string {
  return `@${m.buttonLabel
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function onFieldInput(e: Event, p: ComposerParts): void {
  const at = (e.target as HTMLTextAreaElement).value.endsWith("@");
  if (at && !mentionArmed) {
    mentionArmed = true;
    p.menu.set("mentions");
  } else if (!at) mentionArmed = false;
}

function pick(p: ComposerParts, m: ModelOption): void {
  p.models.select(m.value);
  p.menu.close();
}

function chip(label: string, checked: boolean, onClick: () => void, disabled = false): Tpl {
  return html`<button
    type="button"
    class="scira-chip"
    role="checkbox"
    aria-checked=${checked ? "true" : "false"}
    ?disabled=${disabled}
    @click=${onClick}
  >
    <span class="scira-check">${checked ? icon(Check, 11) : nothing}</span>${label}
  </button>`;
}

function sourcesRow(p: ComposerParts): Tpl {
  if (p.menu.open !== "sources") return nothing;
  return html`<div class="scira-sources" id="composer-sources-menu" role="group" aria-label="Sources">
    ${p.models.harnesses.map((h) =>
      chip(h.label, h.value === p.models.selected.harnessId, () => p.models.selectHarness(h.value)),
    )}
    ${p.fast.supported ? chip("Fast", p.fast.on, () => p.fast.toggle(), !p.fast.available) : nothing}
  </div>`;
}

function modelRow(p: ComposerParts, m: ModelOption, sub: string): Tpl {
  const active = m.value === p.models.selected.value;
  return html`<button
    type="button"
    class="menu-option ${active ? "active" : ""}"
    role="menuitemradio"
    aria-checked=${active ? "true" : "false"}
    @click=${() => pick(p, m)}
  >
    <span class="menu-option-copy">
      <span class="menu-option-label">${m.label}</span>
      <span class="scira-model-desc">${sub}</span>
    </span>
    ${active ? icon(Check, 15) : nothing}
  </button>`;
}

function modelMenu(p: ComposerParts): Tpl {
  const open = p.menu.open === "model";
  const groups = new Map<string, ModelOption[]>();
  for (const m of p.models.all) groups.set(m.harnessLabel, [...(groups.get(m.harnessLabel) ?? []), m]);
  return html`<div class="menu-control scira-model" data-align="left" data-drop="up">
    <button
      type="button"
      class="scira-model-btn"
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      aria-controls="composer-model-menu"
      ?disabled=${p.inputBlocked}
      @click=${(e: Event) => p.menu.toggle(e, "model")}
    >
      ${p.models.selected.buttonLabel} ${icon(ChevronDown, 12)}
    </button>
    ${
      open
        ? html`<div
            class="menu-popover"
            id="composer-model-menu"
            role="menu"
            @click=${(e: Event) => e.stopPropagation()}
          >
            ${[...groups].map(
              ([label, models]) =>
                html`<div class="menu-group-label">${label}</div>
                  ${models.map((m) => modelRow(p, m, describe(m)))}`,
            )}
          </div>`
        : nothing
    }
  </div>`;
}

function field(p: ComposerParts): Tpl {
  return html`<div
    class="menu-control scira-field"
    data-align="left"
    data-drop="up"
    @input=${(e: Event) => onFieldInput(e, p)}
  >
    ${p.textarea}
    ${
      p.menu.open === "mentions"
        ? html`<div
            class="menu-popover"
            id="composer-mentions-menu"
            role="menu"
            @click=${(e: Event) => e.stopPropagation()}
          >
            <div class="menu-title">Mention a model</div>
            ${p.models.all.map((m) => modelRow(p, m, `${handle(m)} · ${m.harnessLabel}`))}
          </div>`
        : nothing
    }
  </div>`;
}

function voiceBar(p: ComposerParts): Tpl {
  return html`<div class="scira-voice" role="group" aria-label="Voice input">
    <div class="scira-eq" aria-hidden="true">
      ${BARS.map((i) => html`<i style="animation-delay: ${(i % 6) * -150}ms"></i>`)}
    </div>
    <span class="scira-voice-label">Listening</span>
    <span class="scira-voice-time">${elapsed()}</span>
    <button type="button" class="scira-voice-end" @click=${() => p.menu.close()}>End</button>
  </div>`;
}

function controls(p: ComposerParts): Tpl {
  const sources = 1 + (p.fast.on ? 1 : 0);
  return html`<div class="scira-left">
      <button
        type="button"
        class="scira-plus"
        aria-label="Sources"
        aria-expanded=${p.menu.open === "sources" ? "true" : "false"}
        aria-controls="composer-sources-menu"
        @click=${(e: Event) => p.menu.toggle(e, "sources")}
      >
        ${icon(Plus, 16)}<span class="scira-badge">${sources}</span>
      </button>
      ${modelMenu(p)}
    </div>
    <div class="scira-right">
      <button
        type="button"
        class="scira-mic"
        aria-label="Voice input"
        @click=${(e: Event) => p.menu.toggle(e, "voice")}
      >
        ${icon(Mic, 16)}
      </button>
      ${p.sendControls}
    </div>`;
}

export const scira: ComposerVariantModule = {
  render: (p) => {
    syncVoiceTimer(p);
    return html`
      <form class="composer-wrap" data-composer="scira" @submit=${p.onSubmit}>
        ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${p.attachments} ${field(p)} ${sourcesRow(p)}
        <div class="scira-row">${p.menu.open === "voice" ? voiceBar(p) : controls(p)}</div>
        ${p.fileInput} ${p.notice}
      </form>
      ${p.pasteDialog}
    `;
  },
};
