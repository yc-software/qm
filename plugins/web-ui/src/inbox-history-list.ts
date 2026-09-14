import { html, type TemplateResult } from "lit";
import { ChevronRight } from "lucide";
import { inboxHistoryDate } from "./inbox-history";
import { icon } from "./ui";

interface InboxHistoryEntry {
  id: string;
  title: string;
  at: number;
}

export function inboxHistoryList(entries: readonly InboxHistoryEntry[], select: (id: string) => void): TemplateResult {
  return html`<div class="inbox-history-list" aria-label="Past conversations">
    ${
      entries.length
        ? entries.map(
            (entry) =>
              html`<button
                class="inbox-history-entry"
                type="button"
                data-history-id=${entry.id}
                @click=${() => select(entry.id)}
              >
                <span class="inbox-history-entry-copy">
                  <span class="inbox-history-entry-title">${entry.title}</span>
                  <span class="inbox-history-meta"
                    ><time datetime=${new Date(entry.at).toISOString()}>${inboxHistoryDate(entry.at)}</time></span
                  >
                </span>
                ${icon(ChevronRight, 13)}
              </button>`,
          )
        : html`<p class="inbox-history-empty">No past conversations yet.</p>`
    }
  </div>`;
}
