import { html, render, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";

export function node(template: unknown): HTMLElement {
  const fragment = document.createDocumentFragment();
  render(template, fragment);
  return fragment.firstElementChild as HTMLElement;
}

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

export function keepSearch(doc: Document, previous: HTMLElement | null, shell: () => void) {
  if (previous && !previous.isConnected) return previous;
  const active = doc.activeElement as HTMLElement | null;
  const focused = !!active && !!previous?.contains(active);
  shell();
  const search = doc.querySelector<HTMLElement>("#shellbar .shell-search");
  if (!previous || !search) return search;
  search.replaceWith(previous);
  if (focused) active?.focus({ preventScroll: true });
  return previous;
}

function cell(value: any): unknown {
  if (value?.node) return value.node;
  if (value?.action) {
    const a = value.action;
    return html`<button
      type="button"
      class=${"rowbtn" + (a.danger ? " danger" : "")}
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
    <button type="button" class="page" ?disabled=${current <= 1} @click=${() => go(current - 1)}>← Prev</button
    ><span class="pageinfo">${offset + 1}–${Math.min(offset + limit, total)} of ${total}</span
    ><button
      type="button"
      class="page"
      ?disabled=${current >= Math.ceil(total / limit)}
      @click=${() => go(current + 1)}
    >
      Next →
    </button>
  </div>`;
}

export function renderer(root: HTMLElement) {
  const end = root.appendChild(document.createComment(""));
  return (template: unknown) => {
    if (end.parentNode === root) render(template, root, { renderBefore: end });
  };
}

export const mount = (root: HTMLElement, template: unknown) => renderer(root)(template);

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

export function mountTemplate(selector: string, template: () => unknown) {
  const placeholder = document.querySelector(selector);
  if (!placeholder) return () => {};
  const root = document.createDocumentFragment();
  const draw = () => render(template(), root);
  draw();
  placeholder.replaceWith(root);
  return draw;
}

export function scroller(from: Element): HTMLElement {
  return from.closest<HTMLElement>(".pane") ?? (document.scrollingElement as HTMLElement);
}

export interface HeaderTab {
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

export const pageHeader = (h: Header) =>
  html`<div class="shellbar">
    ${h.back ? html`<div class="shell-back-row"><a class="back" href=${h.back.href}>← ${h.back.label}</a></div>` : nothing}
    ${h.back && h.title ? html`<h2 class="shell-title">${h.title}</h2>` : nothing}
    ${h.context ? html`<span class="shell-context">${h.context}</span>` : nothing}
    ${
      h.tabs?.length
        ? html`<div class="shell-tabs">
            ${h.tabs.map(
              (tab) =>
                html`<a
                  class=${"shell-tab" + (tab.active ? " active" : "")}
                  href=${tab.href}
                  aria-current=${ifDefined(tab.active ? "page" : undefined)}
                  >${tab.label}${
                    tab.count != null
                      ? html`<span class="shell-tab-count">${tab.count.toLocaleString()}</span>`
                      : nothing
                  }</a
                >`,
            )}
          </div>`
        : nothing
    }
    ${h.count != null && h.count !== "" ? html`<span class="shell-count">${h.count}</span>` : nothing}
    <span class="shell-spacer"></span>
    ${
      h.search
        ? html`<input
            class="shell-search admin-search"
            type="search"
            placeholder=${h.search.placeholder ?? "Search…"}
            aria-label=${(h.search.placeholder ?? "Search").replace(/…$/, "")}
            .value=${h.search.value}
            @input=${(e: Event) => h.search!.onInput((e.target as HTMLInputElement).value)}
          />`
        : nothing
    }
    ${h.actions ?? nothing}
  </div>`;
