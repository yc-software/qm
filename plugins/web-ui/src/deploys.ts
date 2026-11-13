import { openAppPermissions } from "./deploy-permissions";
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
import { withAppDetailNotice, withAppListNotice, withoutAppDetailNotice, type AppNotices } from "./deploy-notices";
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
} from "./deploy-view";
import { tip } from "./tooltip";
import { deepLinkPath, UI_BASE } from "./deep-link";

const DEPLOY_TABS: Array<{ value: AppTab; label: string }> = [
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared" },
  { value: "archived", label: "Archived" },
];

type DeployEditField = "displayName" | "name" | "embedAncestors";

const DEPLOY_EDIT_FIELDS: Record<DeployEditField, { endpoint: string; savedValue: (d: AppView) => string }> = {
  displayName: { endpoint: "display-name", savedValue: (d) => d.displayName ?? "" },
  name: { endpoint: "name", savedValue: (d) => d.name ?? "" },
  embedAncestors: { endpoint: "embed-ancestors", savedValue: (d) => (d.embedAncestors ?? []).join("\n") },
};

let deployList: AppView[] = [];
let deployNotices: AppNotices = { list: "", detail: null };
let deployLoading = false;
let deployScope: string | null = null;
let deployQuery = "";
let deployTab: AppTab = "yours";
let deployPageHost: HTMLElement | null = null;
let activeDeploy: AppView | null = null;
let visibleVersionCount = 10;
let editingDeploy: { id: string; field: DeployEditField } | null = null;
let deployDraft = "";
let embedDraft: string[] = [];
let deploySaving = false;
let archiveCandidate: AppView | null = null;
let restoreArchiveFocus = false;
let deployToast: { app: AppView; text: string; undo?: boolean } | null = null;
let deployRefreshSeq = 0;

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
  return html`<span class="deploy-permission ${manage ? "manage" : "view"}" ${tip(title)}
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

function deployTabs(): TemplateResult {
  const inContext = deployList.filter((d) => appInScope(d, deployScope));
  const viewer = appState.me?.user;
  const counts = Object.fromEntries(
    DEPLOY_TABS.map((tab) => [tab.value, inContext.filter((d) => appTab(d, viewer) === tab.value).length]),
  ) as Record<AppTab, number>;
  const tabs = DEPLOY_TABS.filter((tab) => tab.value === "yours" || counts[tab.value] > 0 || deployTab === tab.value);
  return html`
    <div class="cron-list-controls" role="tablist" aria-label="App view">
      ${tabs.map(
        (tab) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${deployTab === tab.value}
            class="cron-filter-chip ${deployTab === tab.value ? "active" : ""}"
            @click=${() => {
              deployTab = tab.value;
              drawDeploysPage();
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
    <span class="deploy-row-title">
      <span class="list-row-title" dir="auto">${appTitle(d)}</span>
    </span>
  `;
  return html`
    <div class="list-row deploy-row ${d.status === "archived" ? "deploy-row-archived" : ""}">
      ${
        running && d.webUrl
          ? html`<a
              class="deploy-row-main"
              href=${d.webUrl}
              target="_blank"
              rel="noreferrer"
              aria-label=${`Open ${appTitle(d)}`}
              >${title}</a
            >`
          : html`<span class="deploy-row-main">${title}</span>`
      }
      <div class="deploy-row-actions" aria-label="App status and actions">
        <span class="deploy-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
        <button
          class="btn deploy-manage"
          type="button"
          aria-label=${`Manage ${appTitle(d)}`}
          @click=${() => void openDeploy(d)}
        >
          Manage
        </button>
      </div>
    </div>
  `;
}

function drawDeploysPage(): void {
  if (appState.currentView !== "deploys" || !appState.mainEl) return;
  activeDeploy = null;
  if (!deployPageHost || deployPageHost.parentElement !== appState.mainEl) {
    deployPageHost = document.createElement("div");
    deployPageHost.className = "pane deploys-page";
    appState.mainEl.replaceChildren(deployPageHost);
  }
  const viewer = appState.me?.user;
  const rows = filterApps(deployList, {
    tab: deployTab,
    scope: deployScope,
    query: deployQuery,
    viewer,
    sort: "newest",
  });
  const allForTab = deployList.filter((d) => appTab(d, viewer) === deployTab && appInScope(d, deployScope));
  let empty = appTabEmptyMessage(deployTab);
  if (!deployList.length && deployNotices.list) empty = deployNotices.list;
  else if (deployLoading && deployList.length === 0) empty = "Loading apps…";
  else if (deployQuery && allForTab.length) empty = "No apps match your search.";
  else if (deployScope) empty = "No apps in this context.";
  const content = deployList.length
    ? [
        deployTabs(),
        ...(deployNotices.list
          ? [html`<div class="status deploy-list-notice" role="status" aria-live="polite">${deployNotices.list}</div>`]
          : []),
        ...(rows.length ? rows.map(appRow) : [html`<div class="empty compact cron-filter-empty">${empty}</div>`]),
      ]
    : [];
  const scoped = Boolean(scopedSession.active);
  deployPageHost.classList.toggle("scoped-view", scoped);
  render(
    html`
      ${scopedViewTopbar("apps", drawDeploysPage)}
      ${listPageTpl({
        title: "Apps",
        search: {
          value: deployQuery,
          placeholder: "Search apps",
          onInput: (value) => {
            deployQuery = value;
            drawDeploysPage();
          },
        },
        rows: content,
        empty,
      })}
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${deployToast ? undoToast(deployToast) : nothing}
    `,
    deployPageHost,
  );
}

let pendingDeployId: string | null = null;

export function openDeployById(id: string): void {
  pendingDeployId = id;
}

async function openDeploy(d: AppView): Promise<void> {
  visibleVersionCount = 10;
  editingDeploy = null;
  deployDraft = "";
  deployNotices = withoutAppDetailNotice(deployNotices);
  activeDeploy = d;
  history.replaceState(null, "", deepLinkPath(UI_BASE, "deploys", null, null, d.id));
  drawDeployDetail(d, true);
  try {
    const response = await api<{ deployment?: AppView }>(`/api/apps/${encodeURIComponent(d.id)}`);
    if (appState.currentView !== "deploys" || activeDeploy?.id !== d.id) return;
    activeDeploy = response.deployment ?? d;
    drawDeployDetail(activeDeploy);
  } catch (error) {
    if (activeDeploy?.id !== d.id) return;
    deployNotices = withAppDetailNotice(deployNotices, d.id, errMessage(error, "Could not load app details."));
    drawDeployDetail(d);
  }
}

function drawDeployDetail(d: AppView, loading = false): void {
  if (appState.currentView !== "deploys" || !appState.mainEl || activeDeploy?.id !== d.id) return;
  const host = appState.mainEl.querySelector<HTMLElement>(".deploy-detail-pane") ?? document.createElement("div");
  host.className = "resource-pane deploy-detail-pane";
  const versions = [...(d.versions ?? [])].sort((a, b) => b.version - a.version);
  const running = d.status === "running";
  const contextScope = appContextScope(d);
  const editingName = editingDeploy?.id === d.id && editingDeploy.field === "displayName";
  const editingSlug = editingDeploy?.id === d.id && editingDeploy.field === "name";
  const editingEmbed = editingDeploy?.id === d.id && editingDeploy.field === "embedAncestors";
  render(
    html`
      <div class="resource-detail deploy-detail">
        ${listBackLink("Apps", returnToDeploysList)}
        <div class="resource-heading deploy-detail-heading">
          <div>
            <div class="deploy-heading-title">
              <h2 dir="auto">${appTitle(d)}</h2>
              <span class="deploy-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
            </div>
            <div class="deploy-detail-url">/d/${appSlug(d)}/</div>
          </div>
          <div class="actions">
            ${running && d.webUrl ? html`<a class="btn primary" href=${d.webUrl} target="_blank" rel="noreferrer">Open app ${icon(ExternalLink, 14)}</a>` : nothing}
            ${d.webUrl ? html`<button class="btn" type="button" @click=${(event: Event) => void copyText(new URL(d.webUrl!, window.location.href).href, event.currentTarget as HTMLButtonElement)}>${icon(Copy, 14)}<span>Copy URL</span></button>` : nothing}
          </div>
        </div>
        ${loading ? html`<div class="hint">Loading authoritative app details…</div>` : nothing}
        ${deployNotices.detail?.id === d.id ? html`<div class="status">${deployNotices.detail.text}</div>` : nothing}

        <div class="deploy-summary">
          <span>Live v${d.appliedVersion ?? d.currentVersion ?? "—"}</span>
          ${d.currentVersion !== undefined && d.appliedVersion !== undefined && d.currentVersion !== d.appliedVersion ? html`<span>Latest v${d.currentVersion}</span>` : nothing}
          ${appLatestAt(d) ? html`<span ${tip(new Date(appLatestAt(d)).toLocaleString())}>Updated ${relTime(appLatestAt(d))}</span>` : nothing}
        </div>
        <div class="deploy-access-line">
          <div>
            <span>${ownerLabel(d)}</span>
            ${contextScope && contextScope !== d.ownerScopeId ? html`<span class="deploy-secondary-context">Created in ${scopeChip(contextScope)}</span>` : nothing}
            ${d.createdBy && d.ownerScopeId !== `personal:${d.createdBy}` ? html`<span class="deploy-secondary-context">Created by ${d.createdByName ?? friendlyPrincipal(d.createdBy)}</span>` : nothing}
          </div>
          ${d.ownerScopeId === `personal:${appState.me?.user}` ? html`<button class="btn" type="button" @click=${() => void openAppPermissions(d.id, appTitle(d), d.ownerScopeId!)}>Permissions</button>` : permissionBadge(d)}
        </div>

        ${
          canManage(d)
            ? html`<section class="deploy-detail-section">
                <h3>Settings</h3>
                <div class="deploy-setting-row">
                  <div><strong>Display name</strong><span>Shown in the app bar and app list.</span></div>
                  ${editingName ? deployEditForm(d, "displayName") : html`<div class="deploy-setting-value"><span dir="auto">${appTitle(d)}</span><button class="btn" type="button" @click=${() => startEditDeploy(d, "displayName")}>Edit</button></div>`}
                </div>
                <div class="deploy-setting-row">
                  <div><strong>App URL</strong><span>Changes the app URL. Existing links do not redirect.</span></div>
                  ${editingSlug ? deployEditForm(d, "name") : html`<div class="deploy-setting-value"><code>/d/${appSlug(d)}/</code><button class="btn" type="button" @click=${() => startEditDeploy(d, "name")}>Change</button></div>`}
                </div>
                <div class="deploy-setting-row">
                  <div>
                    <strong>Embedding</strong
                    ><span
                      >Sites allowed to show this app inside their own page. Every frame between the app and the browser
                      tab must be listed.</span
                    >
                  </div>
                  ${
                    editingEmbed
                      ? deployEditForm(d, "embedAncestors")
                      : html`<div class="deploy-setting-value">
                          ${embedAncestorsSummary(d)}
                          <button class="btn" type="button" @click=${() => startEditDeploy(d, "embedAncestors")}>
                            ${d.embedAncestors?.length ? "Change" : "Allow"}
                          </button>
                        </div>`
                  }
                </div>
                <div class="actions deploy-danger-actions">
                  ${
                    d.status === "archived"
                      ? html`<button class="btn" type="button" @click=${() => void restoreDeploy(d)}>
                          ${icon(RotateCcw, 14)}<span>Restore app</span>
                        </button>`
                      : html`<button
                          class="btn danger deploy-archive-trigger"
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

        <section class="deploy-detail-section">
          <h3>Version history</h3>
          ${
            versions.length
              ? html`<div class="deploy-version-list">
                  ${versions.slice(0, visibleVersionCount).map(
                    (version) => html`
                      <div class="deploy-version-row">
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
                    drawDeployDetail(d);
                  }}
                >
                  Show older versions
                </button>`
              : nothing
          }
        </section>
      </div>
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${deployToast ? undoToast(deployToast) : nothing}
    `,
    host,
  );
  if (host.parentElement !== appState.mainEl) appState.mainEl.replaceChildren(host);
}

function returnToDeploysList(): void {
  editingDeploy = null;
  deployDraft = "";
  deployNotices = withoutAppDetailNotice(deployNotices);
  activeDeploy = null;
  history.replaceState(null, "", deepLinkPath(UI_BASE, "deploys", null));
  drawDeploysPage();
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
  if (!origins.length) return html`<span class="deploy-embed-empty">Not embeddable</span>`;
  return html`<span class="deploy-embed-origins">${origins.map((origin) => html`<code>${origin}</code>`)}</span>`;
}

function deployEditForm(d: AppView, field: DeployEditField): TemplateResult {
  if (field === "embedAncestors") return deployEmbedForm(d);
  const slug = field === "name";
  return html`
    <form
      class="deploy-edit-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void commitEditDeploy(d);
      }}
    >
      <label>
        <span class="deploy-slug-input ${slug ? "" : "name"}"
          >${slug ? html`<span>/d/</span>` : nothing}<input
            class="deploy-edit-input"
            aria-label=${slug ? "URL slug" : "Display name"}
            ?disabled=${deploySaving}
            .value=${live(deployDraft)}
            @input=${(event: InputEvent) => {
              deployDraft = (event.currentTarget as HTMLInputElement).value;
            }}
            @keydown=${(event: KeyboardEvent) => event.key === "Escape" && cancelEditDeploy()}
          />${slug ? html`<span>/</span>` : nothing}</span
        >
      </label>
      <button class="icon-btn" type="submit" aria-label="Save" ${tip("Save")} ?disabled=${deploySaving}>
        ${icon(Check, 14)}
      </button>
      <button
        class="icon-btn"
        type="button"
        ${tip("Cancel")}
        aria-label="Cancel"
        ?disabled=${deploySaving}
        @click=${cancelEditDeploy}
      >
        ${icon(X, 14)}
      </button>
    </form>
  `;
}

function deployEmbedForm(d: AppView): TemplateResult {
  const setRow = (index: number, value: string) => {
    embedDraft = embedDraft.map((row, i) => (i === index ? value : row));
  };
  const removeRow = (index: number) => {
    embedDraft = embedDraft.filter((_, i) => i !== index);
    if (!embedDraft.length) embedDraft = [""];
    drawDeployDetail(d);
    focusEmbedRow(Math.min(index, embedDraft.length - 1));
  };
  const addRow = () => {
    embedDraft = [...embedDraft, ""];
    drawDeployDetail(d);
    focusEmbedRow(embedDraft.length - 1);
  };
  return html`
    <form
      class="deploy-embed-editor"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void commitEditDeploy(d);
      }}
    >
      <ul class="deploy-embed-list">
        ${embedDraft.map(
          (row, index) => html`
            <li>
              <input
                class="deploy-edit-input deploy-embed-input"
                data-embed-row=${index}
                aria-label="Site allowed to embed this app"
                spellcheck="false"
                placeholder="https://tools.example.com"
                ?disabled=${deploySaving}
                .value=${live(row)}
                @input=${(event: InputEvent) => setRow(index, (event.currentTarget as HTMLInputElement).value)}
                @keydown=${(event: KeyboardEvent) => event.key === "Escape" && cancelEditDeploy()}
              />
              <button
                class="icon-btn"
                type="button"
                ${tip("Remove")}
                aria-label="Remove this site"
                ?disabled=${deploySaving}
                @click=${() => removeRow(index)}
              >
                ${icon(Trash2, 14)}
              </button>
            </li>
          `,
        )}
      </ul>
      <div class="deploy-embed-actions">
        <button class="btn" type="button" ?disabled=${deploySaving} @click=${addRow}>
          ${icon(Plus, 14)}<span>Add site</span>
        </button>
        <span class="spacer"></span>
        <button class="icon-btn" type="submit" aria-label="Save" ${tip("Save")} ?disabled=${deploySaving}>
          ${icon(Check, 14)}
        </button>
        <button
          class="icon-btn"
          type="button"
          ${tip("Cancel")}
          aria-label="Cancel"
          ?disabled=${deploySaving}
          @click=${cancelEditDeploy}
        >
          ${icon(X, 14)}
        </button>
      </div>
      <div class="hint deploy-embed-hint">
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

function startEditDeploy(d: AppView, field: DeployEditField): void {
  editingDeploy = { id: d.id, field };
  if (field === "embedAncestors") embedDraft = [...(d.embedAncestors ?? []), ""];
  else deployDraft = DEPLOY_EDIT_FIELDS[field].savedValue(d);
  deployNotices = withoutAppDetailNotice(deployNotices);
  drawDeployDetail(d);
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(".deploy-edit-input");
    input?.focus();
    input?.select();
  });
}

function cancelEditDeploy(): void {
  editingDeploy = null;
  deployDraft = "";
  embedDraft = [];
  if (activeDeploy) drawDeployDetail(activeDeploy);
  else drawDeploysPage();
}

async function commitEditDeploy(d: AppView): Promise<void> {
  if (!editingDeploy || deploySaving) return;
  const field = editingDeploy.field;
  const value = deployDraft.trim();
  const embedAncestors = field === "embedAncestors" ? cleanEmbedDraft(embedDraft) : [];
  const current = DEPLOY_EDIT_FIELDS[field].savedValue(d);
  const next = field === "embedAncestors" ? embedAncestors.join("\n") : value;
  if (next === current) return cancelEditDeploy();
  if (field === "name" && !value) {
    deployNotices = withAppDetailNotice(deployNotices, d.id, "A URL slug is required.");
    return drawDeployDetail(d);
  }
  deploySaving = true;
  drawDeployDetail(d);
  try {
    const { endpoint } = DEPLOY_EDIT_FIELDS[field];
    const payloads: Record<DeployEditField, object> = {
      displayName: { displayName: value },
      name: { name: value },
      embedAncestors: { embedAncestors },
    };
    const payload = payloads[field];
    await api(`/api/apps/${encodeURIComponent(d.id)}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    editingDeploy = null;
    deployDraft = "";
    embedDraft = [];
    deploySaving = false;
    await refreshApps();
    const updated = deployList.find((item) => item.id === d.id) ?? d;
    if (currentDeployActionView(d.id) === "target") {
      await openDeploy(updated);
    } else {
      deployToast = { app: updated, text: `${appTitle(updated)} settings saved.` };
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "Could not save app settings.");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withAppDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withAppListNotice(deployNotices, "");
      deployToast = { app: d, text: message };
      drawCurrentDeployView();
    }
  }
}

function requestArchive(d: AppView): void {
  restoreArchiveFocus = true;
  archiveCandidate = d;
  drawCurrentDeployView();
  setDeployBackgroundInert(true);
  requestAnimationFrame(() => {
    if (appState.currentView !== "deploys" || archiveCandidate?.id !== d.id) return;
    focusDialogCancel(document);
  });
}

function closeArchiveDialog(): void {
  const restoreFocus = restoreArchiveFocus;
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  restoreArchiveFocus = false;
  drawCurrentDeployView();
  requestAnimationFrame(() => {
    if (!restoreFocus || appState.currentView !== "deploys" || archiveCandidate) return;
    restoreDialogFocus(null, () => document.querySelector<HTMLElement>(".deploy-archive-trigger"));
  });
}

function setDeployBackgroundInert(inert: boolean): void {
  if (inert && appState.currentView !== "deploys") return;
  const roots = new Set<HTMLElement>();
  if (deployPageHost) roots.add(deployPageHost);
  if (appState.currentView === "deploys" && appState.mainEl) roots.add(appState.mainEl);
  roots.forEach((root) =>
    root
      .querySelectorAll<HTMLElement>(".list-page-head, .list-search, .list-rows, .deploy-detail, .deploy-toast")
      .forEach((element) => {
        element.inert = inert;
      }),
  );
}

function drawCurrentDeployView(): void {
  if (appState.currentView !== "deploys") return;
  if (activeDeploy) drawDeployDetail(activeDeploy);
  else drawDeploysPage();
}

function currentDeployActionView(targetId: string): ReturnType<typeof appActionView> {
  return appActionView(targetId, appState.currentView, activeDeploy?.id);
}

function archiveDialog(d: AppView): TemplateResult {
  return html`
    <div
      class="project-dialog-backdrop"
      @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
    >
      <div
        class="project-dialog deploy-archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deploy-archive-title"
        @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
      >
        <div class="project-dialog-head">
          <div>
            <h2 id="deploy-archive-title">Archive <bdi>${appTitle(d)}</bdi>?</h2>
          </div>
        </div>
        <p>
          This takes the app offline immediately, so its current URL will stop working. Its source and version history
          are kept, and you can restore it later.
        </p>
        <div class="project-dialog-actions actions">
          <button class="btn" type="button" data-dialog-cancel @click=${closeArchiveDialog}>Cancel</button>
          <button
            class="btn danger deploy-archive-confirm"
            type="button"
            ?disabled=${deploySaving}
            @click=${() => void archiveDeploy(d)}
          >
            Archive and take offline
          </button>
        </div>
      </div>
    </div>
  `;
}

async function archiveDeploy(d: AppView): Promise<void> {
  if (deploySaving) return;
  deploySaving = true;
  if (activeDeploy?.id === d.id) deployNotices = withAppDetailNotice(deployNotices, d.id, "Archiving app…");
  else deployNotices = withAppListNotice(deployNotices, "Archiving app…");
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  drawCurrentDeployView();
  try {
    await api(`/api/apps/${encodeURIComponent(d.id)}/archive`, { method: "POST" });
    deploySaving = false;
    deployToast = {
      app: { ...d, status: "archived" },
      text: `${appTitle(d)} is offline and archived.`,
      undo: true,
    };
    await refreshApps();
    const destination = currentDeployActionView(d.id);
    if (destination === "target" || destination === "list") {
      activeDeploy = null;
      deployTab = "yours";
      drawDeploysPage();
    } else {
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "Could not archive app.");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withAppDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withAppListNotice(deployNotices, "");
      deployToast = { app: d, text: message };
      drawCurrentDeployView();
    }
  }
}

async function restoreDeploy(d: AppView): Promise<void> {
  if (deploySaving) return;
  const restoringActive = activeDeploy?.id === d.id;
  deploySaving = true;
  if (restoringActive) deployNotices = withAppDetailNotice(deployNotices, d.id, "Restoring app…");
  else if (!activeDeploy) deployNotices = withAppListNotice(deployNotices, "Restoring app…");
  if (restoringActive || !activeDeploy) drawCurrentDeployView();
  try {
    const response = await api<{ deployment?: AppView }>(`/api/apps/${encodeURIComponent(d.id)}/restore`, {
      method: "POST",
    });
    deploySaving = false;
    const restoredResponse = appAfterRestore(d, response.deployment);
    deployToast = { app: restoredResponse, text: `${appTitle(d)} is restored and running.` };
    const refreshResult = await refreshApps();
    const authoritative = refreshResult === "failed" ? undefined : deployList.find((item) => item.id === d.id);
    const restored = appAfterRestore(d, response.deployment, authoritative);
    deployList = appListAfterRestoreRefresh(deployList, restored, refreshResult);
    const destination = currentDeployActionView(d.id);
    if (destination === "target") {
      deployTab = appTab(restored, appState.me?.user);
      activeDeploy = restored;
      await openDeploy(restored);
    } else if (destination === "list") {
      deployTab = appTab(restored, appState.me?.user);
      activeDeploy = null;
      drawDeploysPage();
    } else {
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "Could not restore app.");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withAppDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withAppListNotice(deployNotices, "");
      deployToast = { app: d, text: message };
      drawCurrentDeployView();
    }
  }
}

function undoToast(toast: { app: AppView; text: string; undo?: boolean }): TemplateResult {
  const archived = toast.undo && appArchiveUndoAvailable(toast.app);
  return html`<div class="deploy-toast" role="status">
    <span>${toast.text}</span
    >${archived ? html`<button type="button" ?disabled=${deploySaving} @click=${() => void restoreDeploy(toast.app)}>Undo</button>` : nothing}<button
      class="icon-btn"
      type="button"
      ${tip("Dismiss")}
      aria-label="Dismiss notification"
      @click=${() => {
        deployToast = null;
        drawCurrentDeployView();
      }}
    >
      ${icon(X, 14)}
    </button>
  </div>`;
}

async function refreshApps(): Promise<"updated" | "failed" | "superseded"> {
  const seq = ++deployRefreshSeq;
  try {
    const response = await api<{ deployments?: AppView[] }>("/api/apps");
    if (seq !== deployRefreshSeq) return "superseded";
    deployList = response.deployments ?? [];
    deployNotices = withAppListNotice(deployNotices, "");
    return "updated";
  } catch (error) {
    if (seq !== deployRefreshSeq) return "superseded";
    deployNotices = withAppListNotice(deployNotices, errMessage(error, "Failed to load apps."));
    return "failed";
  } finally {
    if (seq === deployRefreshSeq) deployLoading = false;
  }
}

export async function renderDeploys(): Promise<void> {
  if (appState.currentView !== "deploys") return;
  const requestedId = pendingDeployId;
  pendingDeployId = null;
  archiveCandidate = null;
  restoreArchiveFocus = false;
  setDeployBackgroundInert(false);
  if (scopedSession.active) {
    deployScope = scopedSession.active.scopeId;
    contextsState.selected = null;
  } else if (contextsState.selected) {
    deployScope = contextsState.selected;
    contextsState.selected = null;
  } else {
    deployScope = null;
  }
  const seq = appState.viewRenderSeq;
  await ensureContexts();
  deployLoading = deployList.length === 0;
  deployNotices = withAppListNotice(deployNotices, "");
  drawDeploysPage();
  await refreshApps();
  if (seq !== appState.viewRenderSeq || appState.currentView !== "deploys") return;
  if (requestedId) {
    await openDeploy(deployList.find((d) => d.id === requestedId) ?? { id: requestedId });
  } else if (appListRefreshCanRedraw(activeDeploy?.id)) drawDeploysPage();
}
