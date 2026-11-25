import { html, nothing, type TemplateResult } from "lit";
import { Ghost } from "lucide";
import { icon } from "./icons";

const EPHEMERAL_SUBTITLE = "Not saved to history, memory, or files";

export function ephemeralEmptyTpl(): TemplateResult {
  return html`<div class="ephemeral-empty">
    <h1 class="chat-cta">Hidden chat</h1>
    <p class="ephemeral-subtitle">${EPHEMERAL_SUBTITLE}. Cleared when you leave.</p>
  </div>`;
}

export function ephemeralTopbarTpl(emptyChat: boolean, onClear: () => void): TemplateResult | typeof nothing {
  if (emptyChat) return nothing;
  return html`
    <header class="chat-topbar ephemeral-topbar">
      <div class="chat-heading">
        <div class="chat-title ephemeral-title">${icon(Ghost, 15)}<span>Hidden chat</span></div>
        <div class="chat-subtitle">${EPHEMERAL_SUBTITLE}</div>
      </div>
      <button class="btn compact" type="button" @click=${onClear}>Clear</button>
    </header>
  `;
}
