import { openAppPermissions } from "./app-permissions";
import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Archive, Check, Copy, ExternalLink, Plus, RotateCcw, Trash2, X } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { copyText, relTime } from "./ui";
import { icon } from "./icons";
import { listBackLink, listPageTpl } from "./list-page";
import { contextsState, ensureContexts, scopeChip } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { appState } from "./shell";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { withAppDetailNotice, withAppListNotice, withoutAppDetailNotice, type AppNotices } from "./app-notices";
import {
  appAfterRestore,
  appActionView,
  appArchiveUndoAvailable,
  appCanManage as canManage,
  appContextScope,
  appInScope,
  appListRefreshCanRedraw,
  appListAfterRestoreRefresh,
  appLatestAt,
  appSlug,
  appTab,
  appTabEmptyMessage,
  appTitle,
  filterApps,
  friendlyPrincipal,
  type AppTab,
  type AppView,
} from "./app-view";
import { tip } from "./tooltip";
import { deepLinkPath, UI_BASE } from "./deep-link";

const APP_TABS: Array<{ value: AppTab; label: string }> = [
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared" },
  { value: "archived", label: "Archived" },
];

type AppEditField = "displayName" | "name" | "embedAncestors";

const APP_EDIT_FIELDS: Record<AppEditField, { endpoint: string; savedValue: (d: AppView) => string }> = {
  displayName: { endpoint: "display-name", savedValue: (d) => d.displayName ?? "" },
  name: { endpoint: "name", savedValue: (d) => d.name ?? "" },
  embedAncestors: { endpoint: "embed-ancestors", savedValue: (d) => (d.embedAncestors ?? []).join("\n") },
};

let appList: AppView[] = [];
let appNotices: AppNotices = { list: "", detail: null };
let appLoading = false;
let appScope: string | null = null;
let appQuery = "";
let selectedAppTab: AppTab = "yours";
let appsPageHost: HTMLElement | null = null;
let activeApp: AppView | null = null;
let visibleVersionCount = 10;
let editingApp: { id: string; field: AppEditField } | null = null;
let appDraft = "";
let embedDraft: string[] = [];
let appSaving = false;
let archiveCandidate: AppView | null = null;
let restoreArchiveFocus = false;
let appToast: { app: AppView; text: string; undo?: boolean } | null = null;
let appRefreshSeq = 0;

function statusLabel(d: AppView): string {
  if (
    d.status === "running" &&
    d.appliedVersion !== undefined &&
    d.currentVersion !== undefined &&
    d.appliedVersion !== d.currentVersion
  )
    return "Deploying";
  const status = d.status || "unknown";
  return status.charAt(0).toLocaleUpperCase() + status.slice(1);
}

function statusClass(d: AppView): string {
  if (
    d.status === "running" &&
    d.appliedVersion !== undefined &&
    d.currentVersion !== undefined &&
    d.appliedVersion !== d.currentVersion
  )
    return "deploying";
  if (d.status === "running") return "running";
  if (d.status === "archived") return "archived";
  return "stopped";
}

function permissionBadge(d: AppView): TemplateResult {
  const manage = canManage(d);
  const title = manage
    ? "You own this app or have permission to manage it."
    : "This app is shared with a context you can access. You can open and clone it, but not change it.";
  return html`<span class="app-permission ${manage ? "manage" : "view"}" ${tip(title)}
    >${manage ? "Can manage" : "Can view"}</span
  >`;
}

function ownerLabel(d: AppView): string {
  const me = appState.me?.user;
  if (d.ownerScopeId === `personal:${me}`) return "Owned by you";
  if (d.ownerScopeId?.startsWith("personal:"))
    return `Owned by ${d.ownerName ?? friendlyPrincipal(d.ownerScopeId.slice("personal:".length))}`;
  if (d.ownerScopeId?.startsWith("org:")) return "Organization";
  return "Shared context";
}

function appTabs(): TemplateResult {
  const inContext = appList.filter((d) => appInScope(d, appScope));
  const viewer = appState.me?.user;
  const counts = Object.fromEntries(
    APP_TABS.map((tab) => [tab.value, inContext.filter((d) => appTab(d, viewer) === tab.value).length]),
  ) as Record<AppTab, number>;
  const tabs = APP_TABS.filter((tab) => tab.value === "yours" || counts[tab.value] > 0 || selectedAppTab === tab.value);
  return html`
    <div class="cron-list-controls" role="tablist" aria-label="App view">
      ${tabs.map(
        (tab) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${selectedAppTab === tab.value}
            class="cron-filter-chip ${selectedAppTab === tab.value ? "active" : ""}"
            @click=${() => {
              selectedAppTab = tab.value;
              drawAppsPage();
            }}
          >
            <span>${tab.label}</span><span class="cron-filter-count">${counts[tab.value]}</span>
          </button>
        `,
      )}
    </div>
  `;
}

function appRow(d: AppView): TemplateResult {
  const running = d.status === "running";
  const title = html`
    <span class="app-row-title">
      <span class="list-row-title" dir="auto">${appTitle(d)}</span>
    </span>
  `;
  return html`
    <div class="list-row app-row ${d.status === "archived" ? "app-row-archived" : ""}">
      ${
        running && d.webUrl
          ? html`<a
              class="app-row-main"
              href=${d.webUrl}
              target="_blank"
              rel="noreferrer"
              aria-label=${`Open ${appTitle(d)}`}
              >${title}</a
            >`
          : html`<span class="app-row-main">${title}</span>`
      }
      <div class="app-row-actions" aria-label="App status and actions">
        <span class="app-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
        <button
          class="btn app-manage"
          type="button"
          aria-label=${`Manage ${appTitle(d)}`}
          @click=${() => void openApp(d)}
        >
          Manage
        </button>
      </div>
    </div>
  `;
}

function drawAppsPage(): void {
  if (appState.currentView !== "apps" || !appState.mainEl) return;
  activeApp = null;
  if (!appsPageHost || appsPageHost.parentElement !== appState.mainEl) {
    appsPageHost = document.createElement("div");
    appsPageHost.className = "pane apps-page";
    appState.mainEl.replaceChildren(appsPageHost);
  }
  const viewer = appState.me?.user;
  const rows = filterApps(appList, {
    tab: selectedAppTab,
    scope: appScope,
    query: appQuery,
    viewer,
    sort: "newest",
  });
  const allForTab = appList.filter((d) => appTab(d, viewer) === selectedAppTab && appInScope(d, appScope));
  let empty = appTabEmptyMessage(selectedAppTab);
  if (!appList.length && appNotices.list) empty = appNotices.list;
  else if (appLoading && appList.length === 0) empty = "Loading apps…";
  else if (appQuery && allForTab.length) empty = "No apps match your search.";
  else if (appScope) empty = "No apps in this context.";
  const content = appList.length
    ? [
        appTabs(),
        ...(appNotices.list
          ? [html`<div class="status app-list-notice" role="status" aria-live="polite">${appNotices.list}</div>`]
          : []),
        ...(rows.length ? rows.map(appRow) : [html`<div class="empty compact cron-filter-empty">${empty}</div>`]),
      ]
    : [];
  const scoped = Boolean(scopedSession.active);
  appsPageHost.classList.toggle("scoped-view", scoped);
  render(
    html`
      ${scopedViewTopbar("apps", drawAppsPage)}
      ${listPageTpl({
        title: "Apps",
        search: {
          value: appQuery,
          placeholder: "Search apps",
          onInput: (value) => {
            appQuery = value;
            drawAppsPage();
          },
        },
        rows: content,
        empty,
      })}
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${appToast ? undoToast(appToast) : nothing}
    `,
    appsPageHost,
  );
}

let pendingAppId: string | null = null;

export function openAppById(id: string): void {
  pendingAppId = id;
}

async function openApp(d: AppView): Promise<void> {
  visibleVersionCount = 10;
  editingApp = null;
  appDraft = "";
  appNotices = withoutAppDetailNotice(appNotices);
  activeApp = d;
  history.replaceState(null, "", deepLinkPath(UI_BASE, "apps", null, null, d.id));
  drawAppDetail(d, true);
  try {
    const response = await api<{ app?: AppView }>(`/api/apps/${encodeURIComponent(d.id)}`);
    if (appState.currentView !== "apps" || activeApp?.id !== d.id) return;
    activeApp = response.app ?? d;
    drawAppDetail(activeApp);
  } catch (error) {
    if (activeApp?.id !== d.id) return;
    appNotices = withAppDetailNotice(appNotices, d.id, errMessage(error, "Could not load app details."));
    drawAppDetail(d);
  }
}

function drawAppDetail(d: AppView, loading = false): void {
  if (appState.currentView !== "apps" || !appState.mainEl || activeApp?.id !== d.id) return;
  const host = appState.mainEl.querySelector<HTMLElement>(".app-detail-pane") ?? document.createElement("div");
  host.className = "resource-pane app-detail-pane";
  const versions = [...(d.versions ?? [])].sort((a, b) => b.version - a.version);
  const running = d.status === "running";
  const contextScope = appContextScope(d);
  const editingName = editingApp?.id === d.id && editingApp.field === "displayName";
  const editingSlug = editingApp?.id === d.id && editingApp.field === "name";
  const editingEmbed = editingApp?.id === d.id && editingApp.field === "embedAncestors";
  render(
    html`
      <div class="resource-detail app-detail">
        ${listBackLink("Apps", returnToAppsList)}
        <div class="resource-heading app-detail-heading">
          <div>
            <div class="app-heading-title">
              <h2 dir="auto">${appTitle(d)}</h2>
              <span class="app-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
            </div>
            <div class="app-detail-url">${d.webUrl ?? appSlug(d)}</div>
          </div>
          <div class="actions">
            ${running && d.webUrl ? html`<a class="btn primary" href=${d.webUrl} target="_blank" rel="noreferrer">Open app ${icon(ExternalLink, 14)}</a>` : nothing}
            ${d.webUrl ? html`<button class="btn" type="button" @click=${(event: Event) => void copyText(new URL(d.webUrl!, window.location.href).href, event.currentTarget as HTMLButtonElement)}>${icon(Copy, 14)}<span>Copy URL</span></button>` : nothing}
          </div>
        </div>
        ${loading ? html`<div class="hint">Loading authoritative app details…</div>` : nothing}
        ${appNotices.detail?.id === d.id ? html`<div class="status">${appNotices.detail.text}</div>` : nothing}

        <div class="app-summary">
          <span>Live v${d.appliedVersion ?? d.currentVersion ?? "—"}</span>
          ${d.currentVersion !== undefined && d.appliedVersion !== undefined && d.currentVersion !== d.appliedVersion ? html`<span>Latest v${d.currentVersion}</span>` : nothing}
          ${appLatestAt(d) ? html`<span ${tip(new Date(appLatestAt(d)).toLocaleString())}>Updated ${relTime(appLatestAt(d))}</span>` : nothing}
        </div>
        <div class="app-access-line">
          <div>
            <span>${ownerLabel(d)}</span>
            ${contextScope && contextScope !== d.ownerScopeId ? html`<span class="app-secondary-context">Created in ${scopeChip(contextScope)}</span>` : nothing}
            ${d.createdBy && d.ownerScopeId !== `personal:${d.createdBy}` ? html`<span class="app-secondary-context">Created by ${d.createdByName ?? friendlyPrincipal(d.createdBy)}</span>` : nothing}
          </div>
          ${d.ownerScopeId === `personal:${appState.me?.user}` ? html`<button class="btn" type="button" @click=${() => void openAppPermissions(d.id, appTitle(d), d.ownerScopeId!)}>Permissions</button>` : permissionBadge(d)}
        </div>

        ${
          canManage(d)
            ? html`<section class="app-detail-section">
                <h3>Settings</h3>
                <div class="app-setting-row">
                  <div><strong>Display name</strong><span>Shown in the app bar and app list.</span></div>
                  ${editingName ? appEditForm(d, "displayName") : html`<div class="app-setting-value"><span dir="auto">${appTitle(d)}</span><button class="btn" type="button" @click=${() => startEditApp(d, "displayName")}>Edit</button></div>`}
                </div>
                <div class="app-setting-row">
                  <div><strong>App URL</strong><span>Changes the app URL. Existing links do not redirect.</span></div>
                  ${editingSlug ? appEditForm(d, "name") : html`<div class="app-setting-value"><code>${d.webUrl ?? appSlug(d)}</code><button class="btn" type="button" @click=${() => startEditApp(d, "name")}>Change</button></div>`}
                </div>
                <div class="app-setting-row">
                  <div>
                    <strong>Embedding</strong
                    ><span
                      >Sites allowed to show this app inside their own page. Every frame between the app and the browser
                      tab must be listed.</span
                    >
                  </div>
                  ${
                    editingEmbed
                      ? appEditForm(d, "embedAncestors")
                      : html`<div class="app-setting-value">
                          ${embedAncestorsSummary(d)}
                          <button class="btn" type="button" @click=${() => startEditApp(d, "embedAncestors")}>
                            ${d.embedAncestors?.length ? "Change" : "Allow"}
                          </button>
                        </div>`
                  }
                </div>
                <div class="actions app-danger-actions">
                  ${
                    d.status === "archived"
                      ? html`<button class="btn" type="button" @click=${() => void restoreApp(d)}>
                          ${icon(RotateCcw, 14)}<span>Restore app</span>
                        </button>`
                      : html`<button
                          class="btn danger app-archive-trigger"
                          data-app-id=${d.id}
                          type="button"
                          @click=${() => requestArchive(d)}
                        >
                          ${icon(Archive, 14)}<span>Archive app</span>
                        </button>`
                  }
                </div>
              </section>`
            : nothing
        }

        <section class="app-detail-section">
          <h3>Version history</h3>
          ${
            versions.length
              ? html`<div class="app-version-list">
                  ${versions.slice(0, visibleVersionCount).map(
                    (version) => html`
                      <div class="app-version-row">
                        <div>
                          <strong>v${version.version}</strong
                          >${version.version === d.appliedVersion ? html`<span class="badge ok">Live</span>` : nothing}${version.version === d.currentVersion && version.version !== d.appliedVersion ? html`<span class="badge">Latest</span>` : nothing}
                        </div>
                        <div>
                          <span>${new Date(version.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                    `,
                  )}
                </div>`
              : html`<div class="empty compact">No version history available.</div>`
          }
          ${
            versions.length > visibleVersionCount
              ? html`<button
                  class="btn"
                  type="button"
                  @click=${() => {
                    visibleVersionCount += 10;
                    drawAppDetail(d);
                  }}
                >
                  Show older versions
                </button>`
              : nothing
          }
        </section>
      </div>
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${appToast ? undoToast(appToast) : nothing}
    `,
    host,
  );
  if (host.parentElement !== appState.mainEl) appState.mainEl.replaceChildren(host);
}

function returnToAppsList(): void {
  editingApp = null;
  appDraft = "";
  appNotices = withoutAppDetailNotice(appNotices);
  activeApp = null;
  history.replaceState(null, "", deepLinkPath(UI_BASE, "apps", null));
  drawAppsPage();
}

function cleanEmbedDraft(rows: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

function embedAncestorsSummary(d: AppView): TemplateResult {
  const origins = d.embedAncestors ?? [];
  if (!origins.length) return html`<span class="app-embed-empty">Not embeddable</span>`;
  return html`<span class="app-embed-origins">${origins.map((origin) => html`<code>${origin}</code>`)}</span>`;
}

function appEditForm(d: AppView, field: AppEditField): TemplateResult {
  if (field === "embedAncestors") return appEmbedForm(d);
  const slug = field === "name";
  return html`
    <form
      class="app-edit-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void commitEditApp(d);
      }}
    >
      <label>
        <span class="app-slug-input ${slug ? "" : "name"}"
          ><input
            class="app-edit-input"
            aria-label=${slug ? "URL slug" : "Display name"}
            ?disabled=${appSaving}
            .value=${live(appDraft)}
            @input=${(event: InputEvent) => {
              appDraft = (event.currentTarget as HTMLInputElement).value;
            }}
            @keydown=${(event: KeyboardEvent) => event.key === "Escape" && cancelEditApp()}
        /></span>
      </label>
      <button class="icon-btn" type="submit" aria-label="Save" ${tip("Save")} ?disabled=${appSaving}>
        ${icon(Check, 14)}
      </button>
      <button
        class="icon-btn"
        type="button"
        ${tip("Cancel")}
        aria-label="Cancel"
        ?disabled=${appSaving}
        @click=${cancelEditApp}
      >
        ${icon(X, 14)}
      </button>
    </form>
  `;
}

function appEmbedForm(d: AppView): TemplateResult {
  const setRow = (index: number, value: string) => {
    embedDraft = embedDraft.map((row, i) => (i === index ? value : row));
  };
  const removeRow = (index: number) => {
    embedDraft = embedDraft.filter((_, i) => i !== index);
    if (!embedDraft.length) embedDraft = [""];
    drawAppDetail(d);
    focusEmbedRow(Math.min(index, embedDraft.length - 1));
  };
  const addRow = () => {
    embedDraft = [...embedDraft, ""];
    drawAppDetail(d);
    focusEmbedRow(embedDraft.length - 1);
  };
  return html`
    <form
      class="app-embed-editor"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void commitEditApp(d);
      }}
    >
      <ul class="app-embed-list">
        ${embedDraft.map(
          (row, index) => html`
            <li>
              <input
                class="app-edit-input app-embed-input"
                data-embed-row=${index}
                aria-label="Site allowed to embed this app"
                spellcheck="false"
                placeholder="https://tools.example.com"
                ?disabled=${appSaving}
                .value=${live(row)}
                @input=${(event: InputEvent) => setRow(index, (event.currentTarget as HTMLInputElement).value)}
                @keydown=${(event: KeyboardEvent) => event.key === "Escape" && cancelEditApp()}
              />
              <button
                class="icon-btn"
                type="button"
                ${tip("Remove")}
                aria-label="Remove this site"
                ?disabled=${appSaving}
                @click=${() => removeRow(index)}
              >
                ${icon(Trash2, 14)}
              </button>
            </li>
          `,
        )}
      </ul>
      <div class="app-embed-actions">
        <button class="btn" type="button" ?disabled=${appSaving} @click=${addRow}>
          ${icon(Plus, 14)}<span>Add site</span>
        </button>
        <span class="spacer"></span>
        <button class="icon-btn" type="submit" aria-label="Save" ${tip("Save")} ?disabled=${appSaving}>
          ${icon(Check, 14)}
        </button>
        <button
          class="icon-btn"
          type="button"
          ${tip("Cancel")}
          aria-label="Cancel"
          ?disabled=${appSaving}
          @click=${cancelEditApp}
        >
          ${icon(X, 14)}
        </button>
      </div>
      <div class="hint app-embed-hint">
        An https origin each, e.g. <code>https://tools.example.com</code> or <code>https://*.example.com</code>. Save
        with none listed to forbid embedding again.
      </div>
    </form>
  `;
}

function focusEmbedRow(index: number): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLInputElement>(`[data-embed-row="${index}"]`)?.focus();
  });
}

function startEditApp(d: AppView, field: AppEditField): void {
  editingApp = { id: d.id, field };
  if (field === "embedAncestors") embedDraft = [...(d.embedAncestors ?? []), ""];
  else appDraft = APP_EDIT_FIELDS[field].savedValue(d);
  appNotices = withoutAppDetailNotice(appNotices);
  drawAppDetail(d);
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(".app-edit-input");
    input?.focus();
    input?.select();
  });
}

function cancelEditApp(): void {
  editingApp = null;
  appDraft = "";
  embedDraft = [];
  if (activeApp) drawAppDetail(activeApp);
  else drawAppsPage();
}

async function commitEditApp(d: AppView): Promise<void> {
  if (!editingApp || appSaving) return;
  const field = editingApp.field;
  const value = appDraft.trim();
  const embedAncestors = field === "embedAncestors" ? cleanEmbedDraft(embedDraft) : [];
  const current = APP_EDIT_FIELDS[field].savedValue(d);
  const next = field === "embedAncestors" ? embedAncestors.join("\n") : value;
  if (next === current) return cancelEditApp();
  if (field === "name" && !value) {
    appNotices = withAppDetailNotice(appNotices, d.id, "A URL slug is required.");
    return drawAppDetail(d);
  }
  appSaving = true;
  drawAppDetail(d);
  try {
    const { endpoint } = APP_EDIT_FIELDS[field];
    const payloads: Record<AppEditField, object> = {
      displayName: { displayName: value },
      name: { name: value },
      embedAncestors: { embedAncestors },
    };
    const payload = payloads[field];
    await api(`/api/apps/${encodeURIComponent(d.id)}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    editingApp = null;
    appDraft = "";
    embedDraft = [];
    appSaving = false;
    await refreshApps();
    const updated = appList.find((item) => item.id === d.id) ?? d;
    if (currentAppActionView(d.id) === "target") {
      await openApp(updated);
    } else {
      appToast = { app: updated, text: `${appTitle(updated)} settings saved.` };
      drawCurrentAppView();
    }
  } catch (error) {
    appSaving = false;
    const message = errMessage(error, "Could not save app settings.");
    if (currentAppActionView(d.id) === "target") {
      appNotices = withAppDetailNotice(appNotices, d.id, message);
      drawAppDetail(activeApp!);
    } else {
      appNotices = withAppListNotice(appNotices, "");
      appToast = { app: d, text: message };
      drawCurrentAppView();
    }
  }
}

function requestArchive(d: AppView): void {
  restoreArchiveFocus = true;
  archiveCandidate = d;
  drawCurrentAppView();
  setAppBackgroundInert(true);
  requestAnimationFrame(() => {
    if (appState.currentView !== "apps" || archiveCandidate?.id !== d.id) return;
    focusDialogCancel(document);
  });
}

function closeArchiveDialog(): void {
  const restoreFocus = restoreArchiveFocus;
  setAppBackgroundInert(false);
  archiveCandidate = null;
  restoreArchiveFocus = false;
  drawCurrentAppView();
  requestAnimationFrame(() => {
    if (!restoreFocus || appState.currentView !== "apps" || archiveCandidate) return;
    restoreDialogFocus(null, () => document.querySelector<HTMLElement>(".app-archive-trigger"));
  });
}

function setAppBackgroundInert(inert: boolean): void {
  if (inert && appState.currentView !== "apps") return;
  const roots = new Set<HTMLElement>();
  if (appsPageHost) roots.add(appsPageHost);
  if (appState.currentView === "apps" && appState.mainEl) roots.add(appState.mainEl);
  roots.forEach((root) =>
    root
      .querySelectorAll<HTMLElement>(".list-page-head, .list-search, .list-rows, .app-detail, .app-toast")
      .forEach((element) => {
        element.inert = inert;
      }),
  );
}

function drawCurrentAppView(): void {
  if (appState.currentView !== "apps") return;
  if (activeApp) drawAppDetail(activeApp);
  else drawAppsPage();
}

function currentAppActionView(targetId: string): ReturnType<typeof appActionView> {
  return appActionView(targetId, appState.currentView, activeApp?.id);
}

function archiveDialog(d: AppView): TemplateResult {
  return html`
    <div
      class="project-dialog-backdrop"
      @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
    >
      <div
        class="project-dialog app-archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-archive-title"
        @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
      >
        <div class="project-dialog-head">
          <div>
            <h2 id="app-archive-title">Archive <bdi>${appTitle(d)}</bdi>?</h2>
          </div>
        </div>
        <p>
          This takes the app offline immediately, so its current URL will stop working. Its source and version history
          are kept, and you can restore it later.
        </p>
        <div class="project-dialog-actions actions">
          <button class="btn" type="button" data-dialog-cancel @click=${closeArchiveDialog}>Cancel</button>
          <button
            class="btn danger app-archive-confirm"
            type="button"
            ?disabled=${appSaving}
            @click=${() => void archiveApp(d)}
          >
            Archive and take offline
          </button>
        </div>
      </div>
    </div>
  `;
}

async function archiveApp(d: AppView): Promise<void> {
  if (appSaving) return;
  appSaving = true;
  if (activeApp?.id === d.id) appNotices = withAppDetailNotice(appNotices, d.id, "Archiving app…");
  else appNotices = withAppListNotice(appNotices, "Archiving app…");
  setAppBackgroundInert(false);
  archiveCandidate = null;
  drawCurrentAppView();
  try {
    await api(`/api/apps/${encodeURIComponent(d.id)}/archive`, { method: "POST" });
    appSaving = false;
    appToast = {
      app: { ...d, status: "archived" },
      text: `${appTitle(d)} is offline and archived.`,
      undo: true,
    };
    await refreshApps();
    const destination = currentAppActionView(d.id);
    if (destination === "target" || destination === "list") {
      activeApp = null;
      selectedAppTab = "yours";
      drawAppsPage();
    } else {
      drawCurrentAppView();
    }
  } catch (error) {
    appSaving = false;
    const message = errMessage(error, "Could not archive app.");
    if (currentAppActionView(d.id) === "target") {
      appNotices = withAppDetailNotice(appNotices, d.id, message);
      drawAppDetail(activeApp!);
    } else {
      appNotices = withAppListNotice(appNotices, "");
      appToast = { app: d, text: message };
      drawCurrentAppView();
    }
  }
}

async function restoreApp(d: AppView): Promise<void> {
  if (appSaving) return;
  const restoringActive = activeApp?.id === d.id;
  appSaving = true;
  if (restoringActive) appNotices = withAppDetailNotice(appNotices, d.id, "Restoring app…");
  else if (!activeApp) appNotices = withAppListNotice(appNotices, "Restoring app…");
  if (restoringActive || !activeApp) drawCurrentAppView();
  try {
    const response = await api<{ app?: AppView }>(`/api/apps/${encodeURIComponent(d.id)}/restore`, {
      method: "POST",
    });
    appSaving = false;
    const restoredResponse = appAfterRestore(d, response.app);
    appToast = { app: restoredResponse, text: `${appTitle(d)} is restored and running.` };
    const refreshResult = await refreshApps();
    const authoritative = refreshResult === "failed" ? undefined : appList.find((item) => item.id === d.id);
    const restored = appAfterRestore(d, response.app, authoritative);
    appList = appListAfterRestoreRefresh(appList, restored, refreshResult);
    const destination = currentAppActionView(d.id);
    if (destination === "target") {
      selectedAppTab = appTab(restored, appState.me?.user);
      activeApp = restored;
      await openApp(restored);
    } else if (destination === "list") {
      selectedAppTab = appTab(restored, appState.me?.user);
      activeApp = null;
      drawAppsPage();
    } else {
      drawCurrentAppView();
    }
  } catch (error) {
    appSaving = false;
    const message = errMessage(error, "Could not restore app.");
    if (currentAppActionView(d.id) === "target") {
      appNotices = withAppDetailNotice(appNotices, d.id, message);
      drawAppDetail(activeApp!);
    } else {
      appNotices = withAppListNotice(appNotices, "");
      appToast = { app: d, text: message };
      drawCurrentAppView();
    }
  }
}

function undoToast(toast: { app: AppView; text: string; undo?: boolean }): TemplateResult {
  const archived = toast.undo && appArchiveUndoAvailable(toast.app);
  return html`<div class="app-toast" role="status">
    <span>${toast.text}</span
    >${archived ? html`<button type="button" ?disabled=${appSaving} @click=${() => void restoreApp(toast.app)}>Undo</button>` : nothing}<button
      class="icon-btn"
      type="button"
      ${tip("Dismiss")}
      aria-label="Dismiss notification"
      @click=${() => {
        appToast = null;
        drawCurrentAppView();
      }}
    >
      ${icon(X, 14)}
    </button>
  </div>`;
}

async function refreshApps(): Promise<"updated" | "failed" | "superseded"> {
  const seq = ++appRefreshSeq;
  try {
    const response = await api<{ apps?: AppView[] }>("/api/apps");
    if (seq !== appRefreshSeq) return "superseded";
    appList = response.apps ?? [];
    appNotices = withAppListNotice(appNotices, "");
    return "updated";
  } catch (error) {
    if (seq !== appRefreshSeq) return "superseded";
    appNotices = withAppListNotice(appNotices, errMessage(error, "Failed to load apps."));
    return "failed";
  } finally {
    if (seq === appRefreshSeq) appLoading = false;
  }
}

export async function renderApps(): Promise<void> {
  if (appState.currentView !== "apps") return;
  const requestedId = pendingAppId;
  pendingAppId = null;
  archiveCandidate = null;
  restoreArchiveFocus = false;
  setAppBackgroundInert(false);
  if (scopedSession.active) {
    appScope = scopedSession.active.scopeId;
    contextsState.selected = null;
  } else if (contextsState.selected) {
    appScope = contextsState.selected;
    contextsState.selected = null;
  } else {
    appScope = null;
  }
  const seq = appState.viewRenderSeq;
  await ensureContexts();
  appLoading = appList.length === 0;
  appNotices = withAppListNotice(appNotices, "");
  drawAppsPage();
  await refreshApps();
  if (seq !== appState.viewRenderSeq || appState.currentView !== "apps") return;
  if (requestedId) {
    await openApp(appList.find((d) => d.id === requestedId) ?? { id: requestedId });
  } else if (appListRefreshCanRedraw(activeApp?.id)) drawAppsPage();
}
