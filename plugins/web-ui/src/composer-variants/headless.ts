import { html, nothing, type TemplateResult } from "lit";
import { ArrowUp, Mic, Paperclip, Square } from "lucide";
import type { ComposerParts, ComposerVariantModule } from "../composer-parts";
import { icon } from "../ui.ts";

interface Row {
  label: string;
  pick(): void;
}

interface Trigger {
  key: string;
  rows: Row[];
}

const MENU = "mentions";
const MENU_ID = `composer-${MENU}-menu`;
const VARIABLES = ["today", "model"];
const MENU_KEYS = ["ArrowDown", "ArrowUp", "Enter", "Escape"];
let openedFor: string | null = null;
let activeIndex = 0;

function triggerFor(p: ComposerParts): Trigger | null {
  const mention = /(?:^|\s)@([\w.-]*)$/.exec(p.draft);
  const variable = /\{\{(\w*)$/.exec(p.draft);
  const match = mention ?? variable;
  if (!match) return null;
  const query = (match[1] ?? "").toLowerCase();
  const rows = mention
    ? p.models.all.map((m) => ({ label: `@${m.model.id}`, pick: () => p.models.select(m.value) }))
    : VARIABLES.map((name) => ({ label: `{{${name}}}`, pick: () => p.insertText(`${name.slice(query.length)}}} `) }));
  return {
    key: `${mention ? "@" : "{{"}${p.draft.length - query.length}`,
    rows: rows.filter((row) => row.label.toLowerCase().includes(query)),
  };
}

function syncMenu(p: ComposerParts, trigger: Trigger | null): void {
  if (!trigger) {
    openedFor = null;
    if (p.menu.open === MENU) queueMicrotask(() => p.menu.close());
  } else if (openedFor !== trigger.key) {
    openedFor = trigger.key;
    activeIndex = 0;
    queueMicrotask(() => p.menu.set(MENU));
  }
}

function pick(p: ComposerParts, row: Row | undefined): void {
  row?.pick();
  p.menu.close();
}

function onKeydown(p: ComposerParts, e: KeyboardEvent, rows: Row[] | null): void {
  if (!rows || e.isComposing || !MENU_KEYS.includes(e.key)) return;
  if (e.key !== "Escape" && !rows.length) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") return p.menu.close();
  if (e.key === "Enter") return pick(p, rows[activeIndex]);
  activeIndex = (activeIndex + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
  p.redraw();
}

function listbox(p: ComposerParts, rows: Row[]): TemplateResult {
  return html`<div
    class="menu-popover headless-listbox"
    id=${MENU_ID}
    role="listbox"
    aria-label="Suggestions"
    @click=${(e: Event) => e.stopPropagation()}
    @mousedown=${(e: Event) => e.preventDefault()}
  >
    ${
      rows.length
        ? rows.map(
            (row, i) =>
              html`<button
                class="menu-option ${i === activeIndex ? "active" : ""}"
                type="button"
                role="option"
                aria-selected=${i === activeIndex ? "true" : "false"}
                @click=${() => pick(p, row)}
              >
                ${row.label}
              </button>`,
          )
        : html`<div class="menu-empty">No matches</div>`
    }
  </div>`;
}

function field(p: ComposerParts, rows: Row[] | null): TemplateResult {
  return html`<div class="menu-control headless-trigger" data-align="left" data-drop="up">
    <div
      class="headless-field"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded=${rows ? "true" : "false"}
      aria-controls=${rows ? MENU_ID : nothing}
    >
      ${p.textarea}
    </div>
    ${rows ? listbox(p, rows) : nothing}
  </div>`;
}

function voice(p: ComposerParts): TemplateResult {
  if (p.menu.open === "voice")
    return html`<span class="headless-recording" role="status">
      <span class="headless-recording-dot"></span>Recording… (no audio is captured)
      <button class="headless-recording-stop" type="button" @click=${() => p.menu.close()}>Stop</button>
    </span>`;
  return html`<button
    class="headless-control"
    type="button"
    aria-label="Start voice input"
    ?disabled=${p.inputBlocked}
    @click=${(e: Event) => p.menu.toggle(e, "voice")}
  >
    ${icon(Mic, 18)}
  </button>`;
}

function submit(p: ComposerParts): TemplateResult {
  if (p.send.streaming)
    return html`<button
      class="headless-control headless-submit headless-stop"
      type="button"
      aria-label="Stop"
      @click=${() => p.send.stop()}
    >
      ${icon(Square, 14)}
    </button>`;
  return html`<button
    class="headless-control headless-submit"
    type="submit"
    aria-label="Send"
    ?disabled=${!p.send.canSend}
  >
    ${icon(ArrowUp, 18)}
  </button>`;
}

export const headless: ComposerVariantModule = {
  render: (p) => {
    const trigger = triggerFor(p);
    syncMenu(p, trigger);
    const rows = trigger && p.menu.open === MENU ? trigger.rows : null;
    if (rows) activeIndex = Math.min(activeIndex, Math.max(0, rows.length - 1));
    return html`
      <form
        class="composer-wrap"
        data-composer="headless"
        @submit=${p.onSubmit}
        @keydown=${{ handleEvent: (e: KeyboardEvent) => onKeydown(p, e, rows), capture: true }}
      >
        ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.attachments} ${p.approvals}
        ${p.textarea === nothing ? nothing : field(p, rows)}
        <div class="composer-toolbar">
          ${p.fileInput}
          <button
            class="headless-control"
            type="button"
            aria-label="Attach files"
            ?disabled=${p.attachingDisabled}
            @click=${() => p.pickFiles()}
          >
            ${icon(Paperclip, 18)}
          </button>
          ${voice(p)} ${p.defaultButtons} ${p.settingsMenu} ${submit(p)}
        </div>
        ${p.notice}
      </form>
      ${p.pasteDialog}
    `;
  },
};
