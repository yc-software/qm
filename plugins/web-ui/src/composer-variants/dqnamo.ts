import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowUp, Check, ChevronDown, Paperclip, Search, Square } from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const TINTS = ["blue", "green", "orange", "red"] as const;
const SEARCH_ID = "composer-model-search";
const LIST_ID = "composer-model-list";

let previewId: string | null = null;
let activeIndex = -1;

function tint(provider: string): string {
  let hash = 0;
  for (const ch of provider) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length]!;
}

function providerMark(option: ModelOption) {
  const provider = String(option.model.provider);
  return html`<span class="dq-mark" data-tint=${tint(provider)} aria-hidden="true">
    ${provider.charAt(0).toUpperCase()}
  </span>`;
}

function badges(option: ModelOption): string[] {
  const out: string[] = [];
  if (option.model.input.includes("image")) out.push("Vision");
  if (option.model.reasoning) out.push("Reasoning");
  if (option.model.contextWindow >= 1e6) out.push("1M");
  return out;
}

function contextLabel(tokens: number): string {
  if (tokens >= 1e6) return `${+(tokens / 1e6).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function speedScore(p: ComposerParts, option: ModelOption): number {
  if (p.models.supportsFast(option.model.id)) return 90;
  return option.model.reasoning ? 55 : 72;
}

function metrics(p: ComposerParts, option: ModelOption): Array<{ label: string; score: number; value: string }> {
  const m = option.model;
  const intelligence = m.reasoning ? 92 : 62;
  const speed = speedScore(p, option);
  return [
    { label: "Intelligence", score: intelligence, value: String(intelligence) },
    { label: "Speed", score: speed, value: String(speed) },
    {
      label: "Context",
      score: Math.min(100, Math.round(m.contextWindow / 20000)),
      value: contextLabel(m.contextWindow),
    },
    {
      label: "Cost",
      score: Math.max(10, 100 - Math.round(Math.min(m.cost.input, 20) * 5)),
      value: `$${m.cost.input}/M in`,
    },
  ];
}

function previewCard(p: ComposerParts, option: ModelOption) {
  const selected = option.value === p.models.selected.value;
  return html`
    <div class="dq-preview" aria-live="polite">
      <div class="dq-preview-head">
        ${providerMark(option)}
        <div class="dq-preview-copy">
          <span class="dq-preview-name">${option.label}</span>
          <span class="dq-preview-provider">${option.groupLabel} · ${option.harnessLabel}</span>
        </div>
      </div>
      <div class="dq-badges">${badges(option).map((b) => html`<span class="dq-badge">${b}</span>`)}</div>
      <dl class="dq-metrics">
        ${metrics(p, option).map(
          (metric) => html`
            <div class="dq-metric">
              <dt>${metric.label}</dt>
              <dd>
                <span class="dq-bar"><span class="dq-bar-fill" style="width: ${metric.score}%"></span></span>
                <span class="dq-metric-value">${metric.value}</span>
              </dd>
            </div>
          `,
        )}
      </dl>
      <button class="dq-select" type="button" ?disabled=${selected} @click=${() => p.models.select(option.value)}>
        ${selected ? "Selected" : "Select"}
      </button>
    </div>
  `;
}

function optionRow(p: ComposerParts, option: ModelOption, index: number) {
  const selected = option.value === p.models.selected.value;
  const focus = () => {
    previewId = option.value;
    activeIndex = index;
    p.redraw();
  };
  return html`
    <button
      class="dq-row"
      id="composer-model-option-${index}"
      type="button"
      role="option"
      tabindex="-1"
      aria-selected=${selected ? "true" : "false"}
      ?data-active=${index === activeIndex}
      @mouseenter=${focus}
      @focus=${focus}
      @click=${() => p.models.select(option.value)}
    >
      ${providerMark(option)}
      <span class="dq-row-name">${option.label}</span>
      <span class="dq-badges">${badges(option).map((b) => html`<span class="dq-badge">${b}</span>`)}</span>
      ${selected ? icon(Check, 14) : nothing}
    </button>
  `;
}

function onSearchKey(e: KeyboardEvent, p: ComposerParts, matches: ModelOption[]) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!matches.length) return;
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = activeIndex < 0 && step < 0 ? matches.length - 1 : activeIndex + step;
    activeIndex = (next + matches.length) % matches.length;
    previewId = matches[activeIndex]!.value;
    p.redraw();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const target = matches[activeIndex];
    if (target) p.models.select(target.value);
  }
}

function modelPicker(p: ComposerParts) {
  const open = p.menu.open === "model";
  const selected = p.models.selected;
  if (!open) {
    previewId = null;
    activeIndex = -1;
  }
  const query = p.menu.query.trim().toLocaleLowerCase();
  const matches = p.models.all.filter(
    (m) => !query || `${m.label} ${m.groupLabel} ${m.harnessLabel} ${m.model.id}`.toLocaleLowerCase().includes(query),
  );
  const groups = new Map<string, Array<{ option: ModelOption; index: number }>>();
  matches.forEach((option, index) => {
    groups.set(option.harnessLabel, [...(groups.get(option.harnessLabel) ?? []), { option, index }]);
  });
  const previewed = matches.find((m) => m.value === previewId) ?? selected;
  const active = matches[activeIndex];
  return html`
    <div class="menu-control dq-picker" data-align="left" data-drop="up">
      <button
        class="dq-trigger"
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded=${open ? "true" : "false"}
        aria-controls="composer-model-menu"
        title="Model"
        @click=${(e: Event) => {
          p.menu.toggle(e, "model");
          requestAnimationFrame(() => document.getElementById(SEARCH_ID)?.focus());
        }}
      >
        ${providerMark(selected)}
        <span class="dq-trigger-label">${selected.buttonLabel}</span>
        ${icon(ChevronDown, 12)}
      </button>
      ${
        open
          ? html`<div
              class="menu-popover"
              id="composer-model-menu"
              role="menu"
              @click=${(e: Event) => e.stopPropagation()}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                p.menu.close();
              }}
            >
              <label class="dq-search">
                ${icon(Search, 14)}
                <span class="sr-only">Search models</span>
                <input
                  id=${SEARCH_ID}
                  type="search"
                  role="searchbox"
                  placeholder="Search models…"
                  autocomplete="off"
                  aria-controls=${LIST_ID}
                  aria-activedescendant=${active ? `composer-model-option-${activeIndex}` : nothing}
                  .value=${live(p.menu.query)}
                  @input=${(e: InputEvent) => {
                    activeIndex = -1;
                    p.menu.setQuery((e.currentTarget as HTMLInputElement).value, "model");
                  }}
                  @keydown=${(e: KeyboardEvent) => onSearchKey(e, p, matches)}
                />
              </label>
              <div class="dq-list" id=${LIST_ID} role="listbox" aria-label="Models">
                ${[...groups].map(
                  ([harness, rows]) => html`
                    <div class="dq-group" role="group" aria-label=${harness}>
                      <div class="dq-group-label" aria-hidden="true">${harness}</div>
                      ${rows.map(({ option, index }) => optionRow(p, option, index))}
                    </div>
                  `,
                )}
                ${matches.length ? nothing : html`<div class="menu-empty">No models found</div>`}
              </div>
              ${previewCard(p, previewed)}
            </div>`
          : nothing
      }
    </div>
  `;
}

function sendButton(p: ComposerParts) {
  if (p.send.streaming)
    return html`<button class="dq-send dq-stop" type="button" @click=${() => p.send.stop()}>
      ${icon(Square, 12)}<span>Stop</span>
    </button>`;
  return html`<button class="dq-send" type="submit" ?disabled=${!p.send.canSend}>
    <span>Send</span>${icon(ArrowUp, 14)}
  </button>`;
}

export const dqnamo: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="dqnamo" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.approvals} ${p.attachments} ${p.textarea}
      <div class="composer-toolbar">
        <div class="composer-left">
          ${p.fileInput}
          <button
            class="icon-btn dq-attach"
            type="button"
            aria-label="Attach files"
            ?disabled=${p.attachingDisabled}
            @click=${() => p.pickFiles()}
          >
            ${icon(Paperclip, 15)}
          </button>
          ${modelPicker(p)}
        </div>
        <div class="composer-right">${sendButton(p)}</div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
