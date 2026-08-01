import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowLeft, Plus, RefreshCw, Search } from "lucide";
import { icon } from "./ui";
import { scopeFilterControl } from "./contexts";
import { t } from "./i18n.ts";

export function listBackLink(label: string, onBack: () => void): TemplateResult {
  return html`<button class="context-back" type="button" @click=${onBack}>
    ${icon(ArrowLeft, 15)}<span>${label}</span>
  </button>`;
}

export interface ListPageOpts {
  title: string;
  scope?: string | null;
  onScope?: (scopeId: string | null) => void;
  onRefresh?: () => void;
  action?: { label: string; onClick: () => void };
  controls?: TemplateResult;
  search?: { value: string; placeholder: string; onInput: (value: string) => void };
  filters?: TemplateResult;
  rows: TemplateResult[];
  empty: string | TemplateResult;
}

export function listPageTpl(o: ListPageOpts): TemplateResult {
  return html`
    <div class="list-page-head">
      <h1 class="pane-title">${o.title}</h1>
      <div class="list-page-actions">
        ${o.controls ?? nothing} ${o.onScope ? scopeFilterControl(o.scope ?? null, o.onScope) : nothing}
        ${
          o.onRefresh
            ? html`<button
                class="pane-refresh"
                type="button"
                title=${t("Refresh")}
                aria-label=${t("Refresh")}
                @click=${o.onRefresh}
              >
                ${icon(RefreshCw, 17)}
              </button>`
            : nothing
        }
        ${
          o.action
            ? html`<button class="btn primary list-page-action" type="button" @click=${o.action.onClick}>
                ${icon(Plus, 15)}<span>${o.action.label}</span>
              </button>`
            : nothing
        }
      </div>
    </div>
    ${
      o.search
        ? html`<label class="list-search">
            ${icon(Search, 16)}
            <input
              type="search"
              aria-label=${o.search.placeholder.replace(/…$/, "")}
              placeholder=${o.search.placeholder}
              .value=${live(o.search.value)}
              @input=${(e: Event) => o.search!.onInput((e.currentTarget as HTMLInputElement).value)}
            />
          </label>`
        : nothing
    }
    ${o.filters ?? nothing}
    ${o.rows.length ? html`<div class="list-rows">${o.rows}</div>` : html`<div class="empty compact">${o.empty}</div>`}
  `;
}
