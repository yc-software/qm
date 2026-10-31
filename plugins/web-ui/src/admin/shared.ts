import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { ArrowLeft, Search } from "lucide";
import { icon } from "../icons.ts";

export function badge(text: unknown, kind = "", title = "") {
  return html`<span class=${"badge" + (kind ? " " + kind : "")} title=${ifDefined(title || undefined)}>${text}</span>`;
}

export const empty = (text: unknown) => html`<p class="empty">${text}</p>`;

export const stacked = (primary: unknown, secondary: unknown) =>
  html`<div>
    <div class="primaryline">${primary}</div>
    ${secondary ? html`<div class="subline">${secondary}</div>` : nothing}
  </div>`;

export const subline = (text: unknown) => html`<span class="subline">${text}</span>`;

export const matches = (needle: string, ...parts: unknown[]) =>
  parts.join(" ").toLowerCase().includes(needle.trim().toLowerCase());

function cell(value: any): unknown {
  if (value?.node) return value.node;
  if (value?.action) {
    const a = value.action;
    return html`<button
      type="button"
      class=${"btn compact rowbtn" + (a.danger ? " danger" : "")}
      ?disabled=${!!a.disabled}
      title=${ifDefined(a.title || undefined)}
      @click=${a.run}
    >
      ${a.label}
    </button>`;
  }
  if (value && typeof value === "object") return value.text;
  return value == null ? "" : String(value);
}

export function table(
  headers: unknown[],
  rows: any[][],
  none: string,
  onOpen?: (index: number) => void,
  options: { className?: string; wrapClass?: string } = {},
) {
  if (!rows.length) return empty(none);
  return html`<div class=${"tablewrap" + (options.wrapClass ? " " + options.wrapClass : "")}>
    <table class=${ifDefined(options.className)}>
      <thead>
        <tr>
          ${headers.map((h) => html`<th>${h}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row, i) =>
            html`<tr class=${ifDefined(onOpen ? "openable" : undefined)} @click=${onOpen ? () => onOpen(i) : nothing}>
              ${row.map((value, j) => html`<td class=${ifDefined(value?.cls)}>${onOpen && j === 0 ? html`<div class="open">${cell(value)}</div>` : cell(value)}</td>`)}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function card(title: unknown, subtitle: unknown, content: unknown, headExtra: unknown = nothing) {
  return html`<section class="card">
    <div class="head">
      <h2>${title}</h2>
      ${subtitle ? html`<p>${subtitle}</p>` : nothing}${headExtra}
    </div>
    <div class="body">${content}</div>
  </section>`;
}

export const bareCard = (content: unknown) => html`<section class="card"><div class="body">${content}</div></section>`;

export function pager(total: number, limit: number, offset: number, go: (page: number) => void) {
  if (total <= limit) return nothing;
  const current = Math.floor(offset / limit) + 1;
  return html`<div class="pager">
    <button type="button" class="btn compact page" ?disabled=${current <= 1} @click=${() => go(current - 1)}>
      ← Prev</button
    ><span class="pageinfo">${offset + 1}–${Math.min(offset + limit, total)} of ${total}</span
    ><button
      type="button"
      class="btn compact page"
      ?disabled=${current >= Math.ceil(total / limit)}
      @click=${() => go(current + 1)}
    >
      Next →
    </button>
  </div>`;
}

export function denseList(items: any[], rowOf: (item: any) => any, open: (item: any) => void, none: string) {
  if (!items.length) return empty(none);
  return html`<div class="dense-list">
    ${repeat(
      items,
      (item) => item.id || item.scopeId || item.container || item,
      (item) => {
        const r = rowOf(item);
        const content = html`${r.icon ? html`<span class="dense-icon">${r.icon}</span>` : nothing}<span
            class="dense-name"
            >${r.name}</span
          ><span class="dense-preview">${r.preview ?? ""}</span
          >${r.time != null ? html`<span class="dense-time">${r.time}</span>` : nothing}`;
        const click = (e: MouseEvent) => {
          if (r.href && (r.target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
          if (r.href) e.preventDefault();
          open(item);
        };
        return r.href
          ? html`<a
              class=${"dense-row" + (r.cls ? " " + r.cls : "")}
              href=${r.href}
              target=${ifDefined(r.target)}
              rel=${ifDefined(r.target ? "noopener" : undefined)}
              @click=${click}
              >${content}</a
            >`
          : html`<div
              class=${"dense-row" + (r.cls ? " " + r.cls : "")}
              tabindex="0"
              role="button"
              @click=${click}
              @keydown=${(e: KeyboardEvent) => e.key === "Enter" && open(item)}
            >
              ${content}
            </div>`;
      },
    )}
  </div>`;
}

interface HeaderTab {
  label: string;
  count?: number | null;
  active?: boolean;
  href: string;
}

export interface Header {
  back?: { label: string; href: string };
  title?: unknown;
  context?: unknown;
  tabs?: HeaderTab[];
  count?: unknown;
  search?: { placeholder?: string; value: string; onInput: (value: string) => void };
  actions?: unknown;
}

export const pageHeader = (h: Header) => {
  const tabs = h.tabs?.length
    ? html`<nav class="resource-tabs">
        ${h.tabs.map(
          (tab) =>
            html`<a
              class=${tab.active ? "active" : ""}
              href=${tab.href}
              aria-current=${ifDefined(tab.active ? "page" : undefined)}
              >${tab.label}${tab.count != null ? html`<span>${tab.count.toLocaleString()}</span>` : nothing}</a
            >`,
        )}
      </nav>`
    : nothing;
  const count = h.count != null && h.count !== "" ? html`<span class="pane-subtitle">${h.count}</span>` : nothing;
  const actions = h.actions === nothing ? undefined : h.actions;
  const lead = tabs === nothing ? count : tabs;
  if (!h.back && !h.context && tabs === nothing && count === nothing && !h.search && !actions) return nothing;
  return html`<div class="list-page-head">
      <div>
        ${
          h.back
            ? html`<a class="context-back" href=${h.back.href}>${icon(ArrowLeft, 15)}<span>${h.back.label}</span></a>`
            : lead
        }
        ${h.back && h.title ? html`<h1 class="pane-title">${h.title}</h1>` : nothing}
        ${h.context ? html`<div class="pane-subtitle">${h.context}</div>` : nothing}
      </div>
      <div class="list-page-actions">${lead === count ? nothing : count}${actions ?? nothing}</div>
      ${
        h.search
          ? html`<label class="list-search">
              ${icon(Search, 16)}
              <input
                type="search"
                placeholder=${h.search.placeholder ?? "Search…"}
                aria-label=${(h.search.placeholder ?? "Search").replace(/…$/, "")}
                .value=${h.search.value}
                @input=${(e: Event) => h.search!.onInput((e.target as HTMLInputElement).value)}
              />
            </label>`
          : nothing
      }
    </div>
    ${h.back ? tabs : nothing}`;
};
