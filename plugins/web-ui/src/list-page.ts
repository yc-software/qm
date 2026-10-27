import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ArrowLeft, Plus, Search } from "lucide";
import { icon } from "./icons";
import { contextsState, scopeFilterControl } from "./contexts";
import { fieldSelect } from "./ui";
import { appState, type View } from "./shell-state";
import { scopedSession, scopedViewTopbar, type SessionTool } from "./session-scope";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { trapDialogFocus } from "./dialog-focus";
import { errMessage } from "../../chassis/src/errors";

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

export interface ListTab<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function listTabs<T extends string>(
  label: string,
  tabs: ListTab<T>[],
  active: T,
  onSelect: (value: T) => void,
): TemplateResult {
  return html`<div class="resource-tabs" role="tablist" aria-label=${label}>
    ${tabs.map(
      (tab) =>
        html`<button
          role="tab"
          type="button"
          aria-selected=${tab.value === active}
          class=${tab.value === active ? "active" : ""}
          @click=${() => onSelect(tab.value)}
        >
          ${tab.label}${tab.count === undefined ? nothing : html`<span>${tab.count}</span>`}
        </button>`,
    )}
  </div>`;
}

export function listSelect(
  label: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void,
): TemplateResult {
  return html`<label class="list-select"
    ><span>${label}</span>${fieldSelect({
      compact: true,
      ariaLabel: label,
      value,
      onChange,
      options: options.map(([v, text]) => html`<option value=${v}>${text}</option>`),
    })}</label
  >`;
}

export function groupBy<T>(items: T[], key: (item: T) => string): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups].map(([k, grouped]) => ({ key: k, items: grouped }));
}

export function fieldTpl(label: string | TemplateResult, value: unknown, className = ""): TemplateResult {
  return html`<div class="field">
    <label>${label}</label>
    <div class="value ${className}" dir="auto">${value}</div>
  </div>`;
}

export interface DetailOpts {
  back: string;
  onBack: () => void;
  title: string | TemplateResult;
  heading?: TemplateResult;
  notice?: string;
  body: TemplateResult;
}

export function detailTpl(o: DetailOpts): TemplateResult {
  return html`<div class="resource-detail">
    ${listBackLink(o.back, o.onBack)}
    <div class="resource-heading">
      <h2 dir="auto">${o.title}</h2>
      ${o.heading ?? nothing}
    </div>
    ${o.notice ? html`<div class="action-notice">${o.notice}</div>` : nothing} ${o.body}
  </div>`;
}

export function showPane(className: string, content: TemplateResult): HTMLElement | null {
  if (!appState.mainEl) return null;
  const host = document.createElement("div");
  host.className = `resource-pane ${className}`;
  render(content, host);
  appState.mainEl.replaceChildren(host);
  return host;
}

export interface ConfirmOpts {
  id: string;
  title: TemplateResult;
  body: TemplateResult | string;
  confirm: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function confirmDialogTpl(o: ConfirmOpts): TemplateResult {
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && o.onCancel()}
  >
    <div
      class="project-dialog ${o.id}-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby=${`${o.id}-title`}
      aria-describedby=${`${o.id}-impact`}
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, o.onCancel)}
    >
      <div class="project-dialog-head">
        <div><h2 id=${`${o.id}-title`}>${o.title}</h2></div>
      </div>
      <p id=${`${o.id}-impact`}>${o.body}</p>
      <div class="project-dialog-actions actions">
        <button class="btn" type="button" data-dialog-cancel ?disabled=${Boolean(o.busy)} @click=${o.onCancel}>
          Cancel
        </button>
        <button class="btn danger ${o.id}-confirm" type="button" ?disabled=${Boolean(o.busy)} @click=${o.onConfirm}>
          ${o.confirm}
        </button>
      </div>
    </div>
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
  notice?: string;
  rows: TemplateResult[];
  groups?: Array<{ title: string; rows: TemplateResult[] }>;
  rowsClass?: string;
  empty: string | TemplateResult;
  footer?: TemplateResult;
}

export function listPageTpl(o: ListPageOpts): TemplateResult {
  let body: TemplateResult = html`<div class="empty compact">${o.empty}</div>`;
  if (o.groups?.length)
    body = html`<div class="list-groups">
      ${o.groups.map(
        (group) =>
          html`<section class="list-group">
            <h2>${group.title}</h2>
            ${listRowsTpl(group.rows, o.rowsClass)}
          </section>`,
      )}
    </div>`;
  else if (o.rows.length) body = listRowsTpl(o.rows, o.rowsClass);
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
    ${o.filters ?? nothing} ${o.notice ? html`<div class="status" aria-live="polite">${o.notice}</div>` : nothing}
    ${body} ${o.footer ?? nothing}
  `;
}

export type ArtifactPage = ReturnType<typeof artifactPage>;

export function artifactPage(view: View, className: string, tool?: SessionTool) {
  let seq = 0;
  return {
    loading: false,
    notice: "",
    flash: "",
    scope: null as string | null,
    query: "",
    pending: null as string | null,
    host: null as HTMLElement | null,

    paint(content: TemplateResult, redraw: () => void): HTMLElement | null {
      if (appState.currentView !== view || !appState.mainEl) return null;
      if (!this.host || this.host.parentElement !== appState.mainEl) {
        this.host = document.createElement("div");
        this.host.className = `pane ${className}`;
        appState.mainEl.replaceChildren(this.host);
      }
      this.host.classList.toggle("scoped-view", Boolean(scopedSession.active));
      render(html`${tool ? scopedViewTopbar(tool, redraw) : nothing}${content}`, this.host);
      return this.host;
    },

    adoptScope(): boolean {
      const next = scopedSession.active?.scopeId ?? contextsState.selected;
      contextsState.selected = null;
      const changed = next !== this.scope;
      this.scope = next;
      return changed;
    },

    syncUrl(id: string | null, push = false): void {
      if (appState.currentView !== view) return;
      const next = deepLinkPath(UI_BASE, view, null, null, id);
      if (`${location.pathname}${location.search}` === next) return;
      if (push) history.pushState(null, "", next);
      else history.replaceState(null, "", next);
    },

    takeFlash(): string {
      const flash = this.flash;
      this.flash = "";
      return flash;
    },

    async refresh(run: () => Promise<void>, failure: string, showLoading = false): Promise<boolean> {
      const current = ++seq;
      if (showLoading) {
        this.loading = true;
        this.notice = "";
      }
      try {
        await run();
        if (current !== seq) return false;
        this.notice = "";
        return true;
      } catch (e) {
        if (current !== seq) return false;
        this.notice = errMessage(e, failure);
        return false;
      } finally {
        if (current === seq) this.loading = false;
      }
    },

    matches(text: string): boolean {
      const query = this.query.trim().toLowerCase();
      return !query || text.toLowerCase().includes(query);
    },

    inScope(scopeId: string | null | undefined): boolean {
      return !this.scope || scopeId === this.scope;
    },

    emptyText(noun: string, empty: boolean, fallback = `No ${noun} yet.`): string {
      if (this.notice) return this.notice;
      if (this.loading && empty) return `Loading ${noun}…`;
      if (this.scope) return `No ${noun} in this context.`;
      return fallback;
    },

    async show<T>(o: {
      load: () => Promise<boolean>;
      find: (id: string) => T | undefined;
      open: (item: T) => void;
      draw: () => void;
      missing: string;
    }): Promise<void> {
      o.draw();
      const loaded = await o.load();
      const wanted = this.pending;
      this.pending = null;
      if (appState.currentView !== view) return;
      if (!loaded) return o.draw();
      const item = wanted ? o.find(wanted) : undefined;
      if (wanted && !item) this.flash = o.missing;
      if (item) o.open(item);
      else o.draw();
    },

    route<T>(id: string | null, find: (id: string) => T | undefined, open: (item: T) => void, draw: () => void): void {
      if (appState.currentView !== view) return;
      const item = id ? find(id) : undefined;
      if (item) open(item);
      else draw();
    },
  };
}
