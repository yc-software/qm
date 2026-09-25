import { html, nothing, type TemplateResult } from "lit";

export function searchGroup(title: string, archived: boolean, recency: string): TemplateResult {
  return html`<div class="chat-search-group ${archived ? "archived" : ""}">
    <b dir="auto">${title}</b>${archived ? html`<em class="chat-search-archived-tag">Archived</em>` : nothing}<span
      >${recency}</span
    >
  </div>`;
}
