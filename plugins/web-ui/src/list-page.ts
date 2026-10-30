import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowLeft, Plus, Search } from "lucide";
import { icon } from "./icons";
import { scopeFilterControl } from "./contexts";

export function listBackLink(label: string, onBack: () => void): TemplateResult {
  return html`<button class="context-back" type="button" @click=${onBack}>
    ${icon(ArrowLeft, 15)}<span>${label}</span>
  </button>`;
}

export function listRowsTpl(rows: TemplateResult[], className = ""): TemplateResult {
  return html`<div class="list-rows ${className}">
    ${rows.flatMap((row, i) => (i ? [html`<div class="list-divider" role="presentation"></div>`, row] : row))}
  </div>`;
}

export interface ChipTab {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}

export function chipTabs(label: string, tabs: ChipTab[]): TemplateResult {
  return html`<div class="cron-list-controls" role="tablist" aria-label=${label}>
    ${tabs.map(
      (tab) =>
        html`<button
          type="button"
          role="tab"
          aria-selected=${tab.active}
          class="cron-filter-chip ${tab.active ? "active" : ""}"
          @click=${tab.onClick}
        >
          <span>${tab.label}</span>${
            tab.count === undefined ? nothing : html`<span class="cron-filter-count">${tab.count}</span>`
          }
        </button>`,
    )}
  </div>`;
}

export interface ListPageOpts {
  title: string;
  subtitle?: string;
  scope?: string | null;
  onScope?: (scopeId: string | null) => void;
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
      <div>
        <h1 class="pane-title">${o.title}</h1>
        ${o.subtitle ? html`<div class="pane-subtitle">${o.subtitle}</div>` : nothing}
      </div>
      <div class="list-page-actions">
        ${o.controls ?? nothing} ${o.onScope ? scopeFilterControl(o.scope ?? null, o.onScope) : nothing}
        ${
          o.action
            ? html`<button class="btn primary list-page-action" type="button" @click=${o.action.onClick}>
                ${icon(Plus, 15)}<span>${o.action.label}</span>
              </button>`
            : nothing
        }
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
    </div>
    ${o.filters ?? nothing} ${o.rows.length ? listRowsTpl(o.rows) : html`<div class="empty compact">${o.empty}</div>`}
  `;
}
