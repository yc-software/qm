import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import { ArrowLeft, Plus, Search } from "lucide";
import { fieldSelect, icon, relTime } from "./ui";
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

export interface ListGroup {
  key: string;
  label: string;
  rows: TemplateResult[];
  latest: number;
}

export function groupListRows<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  labelOf: (item: T) => string,
  row: (item: T) => TemplateResult,
  activityOf: (item: T) => number = () => 0,
): ListGroup[] {
  const groups = new Map<string, ListGroup>();
  for (const item of [...items].sort((a, b) => activityOf(b) - activityOf(a))) {
    const key = keyOf(item);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: labelOf(item), rows: [], latest: activityOf(item) };
      groups.set(key, group);
    }
    group.rows.push(row(item));
  }
  return [...groups.values()];
}

export function listGroupsTpl(groups: ListGroup[], searching = false): TemplateResult {
  return html`<div class="list-groups">
    ${repeat(
      groups,
      (group) => `${searching}:${group.key}`,
      (group) => html`
        <details class="list-group" ?open=${searching}>
          <summary>
            <span class="list-group-title">${group.label}</span>
            <span class="list-group-count">${group.rows.length}</span>
            <span class="list-group-time">${group.latest ? relTime(group.latest) : ""}</span>
          </summary>
          ${listRowsTpl(group.rows)}
        </details>
      `,
    )}
  </div>`;
}

export function listTabsTpl<T extends string>(
  label: string,
  tabs: ReadonlyArray<{ value: T; label: string; count: number }>,
  value: T,
  onChange: (value: T) => void,
): TemplateResult {
  return html`<div class="cron-list-controls" role="group" aria-label=${label}>
    ${tabs.map(
      (tab) =>
        html`<button
          type="button"
          aria-pressed=${value === tab.value}
          class="cron-filter-chip ${value === tab.value ? "active" : ""}"
          @click=${() => onChange(tab.value)}
        >
          <span>${tab.label}</span><span class="cron-filter-count">${tab.count}</span>
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
  rows?: TemplateResult[];
  groups?: ListGroup[];
  grouping?: { value: boolean; onChange: (grouped: boolean) => void };
  empty: string | TemplateResult;
}

export function listPageTpl(o: ListPageOpts): TemplateResult {
  let content: TemplateResult = html`<div class="empty compact">${o.empty}</div>`;
  if (o.groups?.length && (o.grouping?.value ?? true))
    content = listGroupsTpl(o.groups, Boolean(o.search?.value.trim()));
  else if (o.rows?.length) content = listRowsTpl(o.rows);
  return html`
    <div class="list-page-head">
      <div>
        <h1 class="pane-title">${o.title}</h1>
        ${o.subtitle ? html`<div class="pane-subtitle">${o.subtitle}</div>` : nothing}
      </div>
      <div class="list-page-actions">
        ${o.controls ?? nothing}
        ${
          o.grouping
            ? html`<label class="list-select"
                ><span>Group by</span>${fieldSelect({
                  compact: true,
                  ariaLabel: "Group by",
                  value: o.grouping.value ? "context" : "none",
                  onChange: (value) => o.grouping!.onChange(value === "context"),
                  options: [html`<option value="context">Context</option>`, html`<option value="none">None</option>`],
                })}</label
              >`
            : nothing
        }
        ${o.onScope ? scopeFilterControl(o.scope ?? null, o.onScope) : nothing}
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
    ${o.filters ?? nothing} ${content}
  `;
}
