import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowLeft, Plus, Search, type IconNode } from "lucide";
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

interface ListGroup {
  label: string;
  body: TemplateResult;
}

export function listGroupsTpl(groups: ListGroup[]): TemplateResult {
  return html`<div class="list-groups">
    ${groups.map(
      (group) =>
        html`<section class="list-group" aria-label=${group.label}>
          <h2>${group.label}</h2>
          ${group.body}
        </section>`,
    )}
  </div>`;
}

export interface ListEmptyOpts {
  icon: IconNode;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}

export function listEmptyTpl(o: ListEmptyOpts): TemplateResult {
  return html`<div class="list-empty-state" role="status">
    <span class="list-empty-state-icon" aria-hidden="true">${icon(o.icon, 22)}</span>
    <div class="list-empty-state-title">${o.title}</div>
    ${o.body ? html`<div class="list-empty-state-body">${o.body}</div>` : nothing}
    ${
      o.action
        ? html`<button class="btn primary list-empty-state-action" type="button" @click=${o.action.onClick}>
            ${o.action.label}
          </button>`
        : nothing
    }
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
  groups?: Array<{ label: string; rows: TemplateResult[] }>;
  empty?: string | TemplateResult;
  emptyState?: ListEmptyOpts;
}

function listBodyTpl(o: ListPageOpts): TemplateResult {
  const groups = (o.groups ?? []).filter((group) => group.rows.length);
  if (groups.length)
    return html`${o.rows.length ? listRowsTpl(o.rows) : nothing}${listGroupsTpl(
      groups.map((group) => ({ label: group.label, body: listRowsTpl(group.rows) })),
    )}`;
  if (o.rows.length) return listRowsTpl(o.rows);
  if (o.emptyState) return listEmptyTpl(o.emptyState);
  return html`<div class="empty compact">${o.empty}</div>`;
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
    ${o.filters ?? nothing} ${listBodyTpl(o)}
  `;
}
