import { html, render, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

export function node(template: unknown): HTMLElement {
  const fragment = document.createDocumentFragment();
  render(template, fragment);
  return fragment.firstElementChild as HTMLElement;
}

export function badge(text: unknown, kind = "") {
  return html`<span class=${"badge" + (kind ? " " + kind : "")}>${text}</span>`;
}

export function cell(value: any): unknown {
  if (value?.node) return value.node;
  if (value?.badges)
    return html`<div class="badges">
      ${value.badges.filter(Boolean).map((b: any) => b.node || (Array.isArray(b) ? badge(b[0], b[1]) : badge(b.text, b.kind)))}
    </div>`;
  if (value?.badge !== undefined) return value.badge ? badge(value.badge, value.kind || "admin") : "-";
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
  empty: string,
  onOpen?: (index: number) => void,
  options: { className?: string; cols?: string[]; wrapClass?: string } = {},
) {
  if (!rows.length) return html`<p class="empty">${empty}</p>`;
  return html`<div class=${"tablewrap" + (options.wrapClass ? " " + options.wrapClass : "")}>
    <table class=${ifDefined(options.className)}>
      ${
        options.cols?.length
          ? html`<colgroup>
              ${options.cols.map((width) => html`<col style=${"width:" + width}></col>`)}
            </colgroup>`
          : nothing
      }
      <thead>
        <tr>
          ${headers.map((h) => html`<th>${h}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row, i) =>
            html`<tr class=${ifDefined(onOpen ? "openable" : undefined)} @click=${onOpen ? () => onOpen(i) : nothing}>
              ${row.map((value, j) => html`<td class=${ifDefined(value?.cls || (value?.badge === "" ? "num" : undefined))}>${onOpen && j === 0 ? html`<div class="open">${cell(value)}</div>` : cell(value)}</td>`)}
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

export function bareCard(content: unknown) {
  return html`<section class="card"><div class="body">${content}</div></section>`;
}

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

export function mount(root: HTMLElement, template: unknown) {
  const end = root.appendChild(document.createComment(""));
  render(template, root, { renderBefore: end });
}

export function renderer(root: HTMLElement) {
  const end = root.appendChild(document.createComment(""));
  return (template: unknown) => {
    if (end.parentNode === root) render(template, root, { renderBefore: end });
  };
}

export function denseList(items: any[], rowOf: (item: any) => any, open: (item: any) => void, empty: string) {
  if (!items.length) return html`<p class="empty">${empty}</p>`;
  return html`<div class="dense-list">
    ${items.map((item) => {
      const r = rowOf(item);
      const content = html`${r.icon ? html`<span class="dense-icon">${r.icon}</span>` : nothing}<span class="dense-name"
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
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") open(item);
            }}
          >
            ${content}
          </div>`;
    })}
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
