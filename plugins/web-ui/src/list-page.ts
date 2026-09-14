import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowLeft, Plus, Search } from "lucide";
import { icon } from "./ui";
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
  emptyHint?: string;
}

function emptyBlock(o: ListPageOpts): TemplateResult {
  if (typeof o.empty !== "string" || !o.emptyHint) {
    return html`<div class="empty compact">${o.empty}</div>`;
  }
  return html`<div class="empty compact empty-state-block">
    <p class="empty-title">${o.empty}</p>
    <p class="empty-hint">${o.emptyHint}</p>
  </div>`;
}

export function listPageTpl(o: ListPageOpts): TemplateResult {
  const searching = Boolean(o.search?.value.trim());
  const showSearch = Boolean(o.search) && (o.rows.length > 0 || searching);
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
        showSearch
          ? html`<label class="list-search">
              ${icon(Search, 16)}
              <input
                type="search"
                aria-label=${o.search!.placeholder.replace(/…$/, "")}
                placeholder=${o.search!.placeholder}
                .value=${live(o.search!.value)}
                @input=${(e: Event) => o.search!.onInput((e.currentTarget as HTMLInputElement).value)}
              />
            </label>`
          : nothing
      }
    </div>
    ${o.filters ?? nothing} ${o.rows.length ? listRowsTpl(o.rows) : emptyBlock(o)}
  `;
}
