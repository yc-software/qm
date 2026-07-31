import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Archive, Check, Copy, ExternalLink, MoreHorizontal, Pencil, RotateCcw, X } from "lucide";
import { api, withBase } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { copyText, fieldSelect, icon, relTime } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { contextsState, ensureContexts, scopeChip } from "./contexts";
import { appState } from "./shell";
import { mainConversation } from "./conversations";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import {
  withDeploymentDetailNotice,
  withDeploymentListNotice,
  withoutDeploymentDetailNotice,
  type DeploymentNotices,
} from "./deploy-notices";
import {
  deploymentAfterRestore,
  deploymentActionView,
  deploymentArchiveUndoAvailable,
  deploymentCanManage as canManage,
  deploymentContextScope,
  deploymentInScope,
  deploymentListRefreshCanRedraw,
  deploymentListAfterRestoreRefresh,
  deploymentLatestAt,
  deploymentSlug,
  deploymentTab,
  deploymentTabEmptyMessage,
  deploymentTitle,
  filterDeployments,
  friendlyPrincipal,
  type DeploymentSort,
  type DeploymentTab,
  type DeploymentView,
} from "./deploy-view";

const DEPLOY_TABS: Array<{ value: DeploymentTab; label: string }> = [
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared" },
  { value: "archived", label: "Archived" },
];

let deployList: DeploymentView[] = [];
let deployNotices: DeploymentNotices = { list: "", detail: null };
let deployLoading = false;
let deployScope: string | null = null;
let deployQuery = "";
let deployTab: DeploymentTab = "yours";
let deploySort: DeploymentSort = "newest";
let deployPageHost: HTMLElement | null = null;
let deployMenuId: string | null = null;
let activeDeploy: DeploymentView | null = null;
let editingDeploy: { id: string; field: "displayName" | "name" } | null = null;
let deployDraft = "";
let deploySaving = false;
let archiveCandidate: DeploymentView | null = null;
let archiveFocusTarget: { id: string; detail: boolean } | null = null;
let deployToast: { deployment: DeploymentView; text: string; undo?: boolean } | null = null;
let deployRefreshSeq = 0;

function statusLabel(d: DeploymentView): string {
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

function statusClass(d: DeploymentView): string {
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

function permissionBadge(d: DeploymentView): TemplateResult {
  const manage = canManage(d);
  const title = manage
    ? "You own this app or have permission to manage it."
    : "This app is shared with a context you can access. You can open and clone it, but not change it.";
  return html`<span class="deploy-permission ${manage ? "manage" : "view"}" title=${title}
    >${manage ? "Can manage" : "Can view"}</span
  >`;
}

function versionLabel(d: DeploymentView): string {
  if (d.currentVersion === undefined) return "Version unknown";
  if (d.appliedVersion !== undefined && d.appliedVersion !== d.currentVersion)
    return `v${d.appliedVersion} live · v${d.currentVersion} pending`;
  return `v${d.currentVersion}`;
}

function deployedLabel(d: DeploymentView): string {
  const at = deploymentLatestAt(d);
  return at ? `Deployed ${relTime(at)}` : "Deployment time unavailable";
}

function ownerLabel(d: DeploymentView): string {
  const me = appState.me?.user;
  if (d.ownerScopeId === `personal:${me}`) return "Your personal context";
  if (d.ownerScopeId?.startsWith("personal:"))
    return `${friendlyPrincipal(d.ownerScopeId.slice("personal:".length))} · Personal`;
  if (d.ownerScopeId?.startsWith("org:")) return "Organization";
  return d.createdBy ? `Shared context · created by ${friendlyPrincipal(d.createdBy)}` : "Shared context";
}

function deployTabs(): TemplateResult {
  const inContext = deployList.filter((d) => deploymentInScope(d, deployScope));
  const viewer = appState.me?.user;
  const counts = Object.fromEntries(
    DEPLOY_TABS.map((tab) => [tab.value, inContext.filter((d) => deploymentTab(d, viewer) === tab.value).length]),
  ) as Record<DeploymentTab, number>;
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
              deployMenuId = null;
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

function deploymentRow(d: DeploymentView): TemplateResult {
  const running = d.status === "running";
  const contextScope = deploymentContextScope(d);
  return html`
    <div class="list-row deploy-row ${d.status === "archived" ? "deploy-row-archived" : ""}">
      <button class="deploy-row-main" type="button" @click=${() => void openDeploy(d)}>
        <span class="deploy-row-title">
          <span class="list-row-title">${deploymentTitle(d)}</span>
          <span class="deploy-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
        </span>
        <span class="deploy-row-url">/d/${deploymentSlug(d)}/</span>
        <span class="list-row-meta deploy-row-meta">
          ${contextScope ? scopeChip(contextScope) : nothing}
          <span>${ownerLabel(d)}</span>
          ${canManage(d) ? permissionBadge(d) : nothing}
          <span>${versionLabel(d)}</span>
          <span>${deployedLabel(d)}</span>
        </span>
      </button>
      <div class="deploy-row-actions" aria-label="App actions">
        ${
          running && d.webUrl
            ? html`<a class="btn deploy-open" href=${withBase(d.webUrl)} target="_blank" rel="noreferrer"
                >Open ${icon(ExternalLink, 14)}</a
              >`
            : nothing
        }
        ${
          d.webUrl
            ? html`<button
                class="icon-btn subtle"
                type="button"
                title="Copy app URL"
                aria-label="Copy app URL"
                @click=${(event: Event) => void copyText(new URL(withBase(d.webUrl!), window.location.href).href, event.currentTarget as HTMLButtonElement)}
              >
                ${icon(Copy, 14)}
              </button>`
            : nothing
        }
        ${canManage(d) ? deployMenu(d) : nothing}
      </div>
    </div>
  `;
}

function deployMenu(d: DeploymentView): TemplateResult {
  const open = deployMenuId === d.id;
  return html`
    <div class="session-menu deploy-menu">
      <button
        class="session-menu-btn deploy-menu-trigger"
        data-deployment-id=${d.id}
        type="button"
        aria-label=${`More actions for ${deploymentTitle(d)}`}
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        @click=${(event: Event) => {
          event.stopPropagation();
          deployMenuId = open ? null : d.id;
          drawDeploysPage();
        }}
      >
        ${icon(MoreHorizontal, 16)}
      </button>
      ${
        open
          ? html`<div class="session-menu-popover" role="menu" @click=${(event: Event) => event.stopPropagation()}>
              ${
                d.status === "archived"
                  ? html`<button
                      class="session-menu-option"
                      type="button"
                      role="menuitem"
                      @click=${() => void restoreDeploy(d)}
                    >
                      ${icon(RotateCcw, 15)}<span>Restore</span>
                    </button>`
                  : html`
                      <button
                        class="session-menu-option"
                        type="button"
                        role="menuitem"
                        @click=${() => void editFromList(d, "displayName")}
                      >
                        ${icon(Pencil, 15)}<span>Edit display name</span>
                      </button>
                      <button
                        class="session-menu-option"
                        type="button"
                        role="menuitem"
                        @click=${() => void editFromList(d, "name")}
                      >
                        ${icon(Pencil, 15)}<span>Change URL slug</span>
                      </button>
                      <button
                        class="session-menu-option danger"
                        type="button"
                        role="menuitem"
                        @click=${() => requestArchive(d)}
                      >
                        ${icon(Archive, 15)}<span>Archive</span>
                      </button>
                    `
              }
            </div>`
          : nothing
      }
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
  const rows = filterDeployments(deployList, {
    tab: deployTab,
    scope: deployScope,
    query: deployQuery,
    viewer,
    sort: deploySort,
  });
  const allForTab = deployList.filter(
    (d) => deploymentTab(d, viewer) === deployTab && deploymentInScope(d, deployScope),
  );
  let empty = deploymentTabEmptyMessage(deployTab);
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
        ...(rows.length
          ? rows.map(deploymentRow)
          : [html`<div class="empty compact cron-filter-empty">${empty}</div>`]),
      ]
    : [];
  render(
    html`
      ${listPageTpl({
        title: "Apps",
        scope: deployScope,
        onScope: (scope) => {
          deployScope = scope;
          drawDeploysPage();
        },
        onRefresh: () => void renderDeploys(),
        action: { label: "Deploy with Agent", onClick: deployWithAgent },
        controls: html`<label class="deploy-sort"
          ><span>Sort</span>${fieldSelect({
            compact: true,
            ariaLabel: "Sort apps",
            value: deploySort,
            onChange: (value) => {
              deploySort = value as DeploymentSort;
              drawDeploysPage();
            },
            options: [
              html`<option value="newest">Newest</option>`,
              html`<option value="name">Name</option>`,
              html`<option value="status">Status</option>`,
            ],
          })}</label
        >`,
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

async function openDeploy(d: DeploymentView): Promise<void> {
  deployMenuId = null;
  editingDeploy = null;
  deployDraft = "";
  deployNotices = withoutDeploymentDetailNotice(deployNotices);
  activeDeploy = d;
  drawDeployDetail(d, true);
  try {
    const response = await api<{ deployment?: DeploymentView }>(`/api/deployments/${encodeURIComponent(d.id)}`);
    if (appState.currentView !== "deploys" || activeDeploy?.id !== d.id) return;
    activeDeploy = response.deployment ?? d;
    drawDeployDetail(activeDeploy);
  } catch (error) {
    if (activeDeploy?.id !== d.id) return;
    deployNotices = withDeploymentDetailNotice(deployNotices, d.id, errMessage(error, "Could not load app details."));
    drawDeployDetail(d);
  }
}

function drawDeployDetail(d: DeploymentView, loading = false): void {
  if (appState.currentView !== "deploys" || !appState.mainEl || activeDeploy?.id !== d.id) return;
  const host = document.createElement("div");
  host.className = "resource-pane deploy-detail-pane";
  const versions = [...(d.versions ?? [])].sort((a, b) => b.version - a.version);
  const running = d.status === "running";
  const contextScope = deploymentContextScope(d);
  const editingName = editingDeploy?.id === d.id && editingDeploy.field === "displayName";
  const editingSlug = editingDeploy?.id === d.id && editingDeploy.field === "name";
  render(
    html`
      <div class="resource-detail deploy-detail">
        ${listBackLink("Apps", returnToDeploysList)}
        <div class="resource-heading deploy-detail-heading">
          <div>
            <div class="deploy-heading-title">
              <h2>${deploymentTitle(d)}</h2>
              <span class="deploy-status ${statusClass(d)}"><span></span>${statusLabel(d)}</span>
            </div>
            <div class="deploy-detail-url">/d/${deploymentSlug(d)}/</div>
          </div>
          <div class="actions">
            ${running && d.webUrl ? html`<a class="btn primary" href=${withBase(d.webUrl)} target="_blank" rel="noreferrer">Open app ${icon(ExternalLink, 14)}</a>` : nothing}
            ${running && canManage(d) ? html`<button class="btn" type="button" @click=${(event: Event) => void openLiveEdit(d, event.currentTarget as HTMLButtonElement)}>${icon(Pencil, 14)}<span>Edit live</span></button>` : nothing}
            ${d.webUrl ? html`<button class="btn" type="button" @click=${(event: Event) => void copyText(new URL(withBase(d.webUrl!), window.location.href).href, event.currentTarget as HTMLButtonElement)}>${icon(Copy, 14)}<span>Copy URL</span></button>` : nothing}
          </div>
        </div>
        ${loading ? html`<div class="hint">Loading authoritative app details…</div>` : nothing}
        ${deployNotices.detail?.id === d.id ? html`<div class="status">${deployNotices.detail.text}</div>` : nothing}

        <section class="deploy-detail-section">
          <h3>Overview</h3>
          <div class="deploy-facts">
            <div><span>Status</span><strong>${statusLabel(d)}</strong></div>
            <div><span>Live version</span><strong>${d.appliedVersion ?? d.currentVersion ?? "—"}</strong></div>
            <div><span>Latest version</span><strong>${d.currentVersion ?? "—"}</strong></div>
            <div>
              <span>Last deployed</span
              ><strong>${deploymentLatestAt(d) ? new Date(deploymentLatestAt(d)).toLocaleString() : "—"}</strong>
            </div>
            <div>
              <span>Last opened</span
              ><strong>${d.lastAccessAt ? relTime(d.lastAccessAt) : "No recorded access"}</strong>
            </div>
            <div><span>Access</span><strong>${permissionBadge(d)}</strong></div>
          </div>
        </section>

        <section class="deploy-detail-section">
          <h3>Ownership and access</h3>
          <div class="field">
            <label>Created in</label>
            <div class="value">${contextScope ? scopeChip(contextScope) : "Unknown"}</div>
          </div>
          <div class="field">
            <label>Owner</label>
            <div class="value">${ownerLabel(d)}</div>
          </div>
          ${
            d.createdBy
              ? html`<div class="field">
                  <label>Created by</label>
                  <div class="value">${friendlyPrincipal(d.createdBy)}</div>
                </div>`
              : nothing
          }
          ${
            d.gitUrl
              ? html`<div class="field deploy-git-field">
                  <label>Git remote</label>
                  <div class="value">
                    <code>${d.gitUrl}</code
                    ><button
                      class="icon-btn subtle"
                      type="button"
                      title="Copy Git remote"
                      aria-label="Copy Git remote"
                      @click=${(event: Event) => void copyText(d.gitUrl!, event.currentTarget as HTMLButtonElement)}
                    >
                      ${icon(Copy, 14)}
                    </button>
                  </div>
                  <p class="hint">
                    ${d.permission === "write" ? "Clone or push a new version with this short-lived authenticated URL." : "Clone source with this short-lived read-only authenticated URL."}
                  </p>
                </div>`
              : nothing
          }
        </section>

        ${
          canManage(d)
            ? html`<section class="deploy-detail-section">
                <h3>Settings</h3>
                <div class="deploy-setting-row">
                  <div>
                    <strong>Display name</strong
                    ><span>The human-friendly name shown here. This does not change the app URL.</span>
                  </div>
                  ${editingName ? deployEditForm(d, "displayName") : html`<div class="deploy-setting-value"><span>${d.displayName || "Using URL slug"}</span><button class="btn" type="button" @click=${() => startEditDeploy(d, "displayName")}>Edit</button></div>`}
                </div>
                <div class="deploy-setting-row">
                  <div><strong>URL slug</strong><span>Changes the app URL. Existing links do not redirect.</span></div>
                  ${editingSlug ? deployEditForm(d, "name") : html`<div class="deploy-setting-value"><code>/d/${deploymentSlug(d)}/</code><button class="btn" type="button" @click=${() => startEditDeploy(d, "name")}>Change</button></div>`}
                </div>
                <div class="actions deploy-danger-actions">
                  ${
                    d.status === "archived"
                      ? html`<button class="btn" type="button" @click=${() => void restoreDeploy(d)}>
                          ${icon(RotateCcw, 14)}<span>Restore deployment</span>
                        </button>`
                      : html`<button
                          class="btn danger deploy-archive-trigger"
                          data-deployment-id=${d.id}
                          type="button"
                          @click=${() => requestArchive(d)}
                        >
                          ${icon(Archive, 14)}<span>Archive deployment</span>
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
                  ${versions.map(
                    (version) => html`
                      <div class="deploy-version-row">
                        <div>
                          <strong>v${version.version}</strong
                          >${version.version === d.appliedVersion ? html`<span class="badge ok">Live</span>` : nothing}${version.version === d.currentVersion && version.version !== d.appliedVersion ? html`<span class="badge">Latest</span>` : nothing}
                        </div>
                        <div>
                          <span>${new Date(version.createdAt).toLocaleString()}</span
                          >${version.commit ? html`<code title=${version.commit}>${version.commit.slice(0, 10)}</code>` : nothing}
                        </div>
                      </div>
                    `,
                  )}
                </div>`
              : html`<div class="empty compact">No version history available.</div>`
          }
        </section>
      </div>
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${deployToast ? undoToast(deployToast) : nothing}
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
}

function returnToDeploysList(): void {
  editingDeploy = null;
  deployDraft = "";
  deployNotices = withoutDeploymentDetailNotice(deployNotices);
  activeDeploy = null;
  drawDeploysPage();
}

function deployEditForm(d: DeploymentView, field: "displayName" | "name"): TemplateResult {
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
      <button class="icon-btn" type="submit" title="Save" aria-label="Save" ?disabled=${deploySaving}>
        ${icon(Check, 14)}
      </button>
      <button
        class="icon-btn"
        type="button"
        title="Cancel"
        aria-label="Cancel"
        ?disabled=${deploySaving}
        @click=${cancelEditDeploy}
      >
        ${icon(X, 14)}
      </button>
    </form>
  `;
}

async function editFromList(d: DeploymentView, field: "displayName" | "name"): Promise<void> {
  await openDeploy(d);
  if (activeDeploy?.id === d.id) startEditDeploy(activeDeploy, field);
}

function startEditDeploy(d: DeploymentView, field: "displayName" | "name"): void {
  editingDeploy = { id: d.id, field };
  deployDraft = field === "displayName" ? (d.displayName ?? "") : (d.name ?? "");
  deployNotices = withoutDeploymentDetailNotice(deployNotices);
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
  if (activeDeploy) drawDeployDetail(activeDeploy);
  else drawDeploysPage();
}

async function commitEditDeploy(d: DeploymentView): Promise<void> {
  if (!editingDeploy || deploySaving) return;
  const field = editingDeploy.field;
  const value = deployDraft.trim();
  const current = field === "displayName" ? (d.displayName ?? "") : (d.name ?? "");
  if (value === current) return cancelEditDeploy();
  if (field === "name" && !value) {
    deployNotices = withDeploymentDetailNotice(deployNotices, d.id, "A URL slug is required.");
    return drawDeployDetail(d);
  }
  deploySaving = true;
  drawDeployDetail(d);
  try {
    const endpoint = field === "displayName" ? "display-name" : "name";
    const payload = field === "displayName" ? { displayName: value } : { name: value };
    await api(`/api/deployments/${encodeURIComponent(d.id)}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    editingDeploy = null;
    deployDraft = "";
    deploySaving = false;
    await refreshDeployments();
    const updated = deployList.find((item) => item.id === d.id) ?? d;
    if (currentDeployActionView(d.id) === "target") {
      await openDeploy(updated);
    } else {
      deployToast = { deployment: updated, text: `${deploymentTitle(updated)} settings saved.` };
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "Could not save app settings.");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withDeploymentDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withDeploymentListNotice(deployNotices, "");
      deployToast = { deployment: d, text: message };
      drawCurrentDeployView();
    }
  }
}

function requestArchive(d: DeploymentView): void {
  archiveFocusTarget = { id: d.id, detail: activeDeploy?.id === d.id };
  deployMenuId = null;
  archiveCandidate = d;
  drawCurrentDeployView();
  setDeployBackgroundInert(true);
  requestAnimationFrame(() => {
    if (appState.currentView !== "deploys" || archiveCandidate?.id !== d.id) return;
    focusDialogCancel(document);
  });
}

function closeArchiveDialog(): void {
  const focusTarget = archiveFocusTarget;
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  archiveFocusTarget = null;
  drawCurrentDeployView();
  requestAnimationFrame(() => {
    if (!focusTarget || appState.currentView !== "deploys" || archiveCandidate) return;
    restoreDialogFocus(null, () =>
      focusTarget.detail
        ? document.querySelector<HTMLElement>(".deploy-archive-trigger")
        : deploymentMenuTrigger(focusTarget.id),
    );
  });
}

function deploymentMenuTrigger(id: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".deploy-menu-trigger")].find(
    (element) => element.dataset.deploymentId === id,
  );
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

function currentDeployActionView(targetId: string): ReturnType<typeof deploymentActionView> {
  return deploymentActionView(targetId, appState.currentView, activeDeploy?.id);
}

function archiveDialog(d: DeploymentView): TemplateResult {
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
          <div><h2 id="deploy-archive-title">Archive ${deploymentTitle(d)}?</h2></div>
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

async function archiveDeploy(d: DeploymentView): Promise<void> {
  if (deploySaving) return;
  deploySaving = true;
  if (activeDeploy?.id === d.id)
    deployNotices = withDeploymentDetailNotice(deployNotices, d.id, "Archiving deployment…");
  else deployNotices = withDeploymentListNotice(deployNotices, "Archiving deployment…");
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  drawCurrentDeployView();
  try {
    await api(`/api/deployments/${encodeURIComponent(d.id)}/archive`, { method: "POST" });
    deploySaving = false;
    deployToast = {
      deployment: { ...d, status: "archived" },
      text: `${deploymentTitle(d)} is offline and archived.`,
      undo: true,
    };
    await refreshDeployments();
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
    const message = errMessage(error, "Could not archive deployment.");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withDeploymentDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withDeploymentListNotice(deployNotices, "");
      deployToast = { deployment: d, text: message };
      drawCurrentDeployView();
    }
  }
}

async function restoreDeploy(d: DeploymentView): Promise<void> {
  if (deploySaving) return;
  const restoringActive = activeDeploy?.id === d.id;
  deploySaving = true;
  deployMenuId = null;
  if (restoringActive) deployNotices = withDeploymentDetailNotice(deployNotices, d.id, "Restoring deployment…");
  else if (!activeDeploy) deployNotices = withDeploymentListNotice(deployNotices, "Restoring deployment…");
  if (restoringActive || !activeDeploy) drawCurrentDeployView();
  try {
    const response = await api<{ deployment?: DeploymentView }>(
      `/api/deployments/${encodeURIComponent(d.id)}/restore`,
      { method: "POST" },
    );
    deploySaving = false;
    const restoredResponse = deploymentAfterRestore(d, response.deployment);
    deployToast = { deployment: restoredResponse, text: `${deploymentTitle(d)} is restored and running.` };
    const refreshResult = await refreshDeployments();
    const authoritative = refreshResult === "failed" ? undefined : deployList.find((item) => item.id === d.id);
    const restored = deploymentAfterRestore(d, response.deployment, authoritative);
    deployList = deploymentListAfterRestoreRefresh(deployList, restored, refreshResult);
    const destination = currentDeployActionView(d.id);
    if (destination === "target") {
      deployTab = deploymentTab(restored, appState.me?.user);
      activeDeploy = restored;
      await openDeploy(restored);
    } else if (destination === "list") {
      deployTab = deploymentTab(restored, appState.me?.user);
      activeDeploy = null;
      drawDeploysPage();
    } else {
      drawCurrentDeployView();
    }
  } catch (error) {
    deploySaving = false;
    const message = errMessage(error, "Could not restore deployment.");
    if (currentDeployActionView(d.id) === "target") {
      deployNotices = withDeploymentDetailNotice(deployNotices, d.id, message);
      drawDeployDetail(activeDeploy!);
    } else {
      deployNotices = withDeploymentListNotice(deployNotices, "");
      deployToast = { deployment: d, text: message };
      drawCurrentDeployView();
    }
  }
}

function undoToast(toast: { deployment: DeploymentView; text: string; undo?: boolean }): TemplateResult {
  const archived = toast.undo && deploymentArchiveUndoAvailable(toast.deployment);
  return html`<div class="deploy-toast" role="status">
    <span>${toast.text}</span
    >${archived ? html`<button type="button" ?disabled=${deploySaving} @click=${() => void restoreDeploy(toast.deployment)}>Undo</button>` : nothing}<button
      class="icon-btn"
      type="button"
      title="Dismiss"
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

async function openLiveEdit(d: DeploymentView, button: HTMLButtonElement): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const r = await api<{ url?: string }>(`/api/deployments/${encodeURIComponent(d.id)}/owner-url`);
    if (!r.url) throw new Error("no live URL for this app");
    if (tab) tab.location.href = r.url;
    else window.open(r.url, "_blank");
  } catch (error) {
    tab?.close();
    deployNotices = withDeploymentDetailNotice(deployNotices, d.id, errMessage(error, "Could not open live editing."));
    drawDeployDetail(activeDeploy ?? d);
    button.blur();
  }
}

function deployWithAgent(): void {
  const conv = mainConversation();
  conv.newChat();
  conv.composer.state.draft = "Deploy an app for me. ";
  conv.drawActiveChat(conv.state.agent);
  conv.composer.focusComposerEnd();
}

async function refreshDeployments(): Promise<"updated" | "failed" | "superseded"> {
  const seq = ++deployRefreshSeq;
  try {
    const response = await api<{ deployments?: DeploymentView[] }>("/api/deployments");
    if (seq !== deployRefreshSeq) return "superseded";
    deployList = response.deployments ?? [];
    deployNotices = withDeploymentListNotice(deployNotices, "");
    return "updated";
  } catch (error) {
    if (seq !== deployRefreshSeq) return "superseded";
    deployNotices = withDeploymentListNotice(deployNotices, errMessage(error, "Failed to load apps."));
    return "failed";
  } finally {
    if (seq === deployRefreshSeq) deployLoading = false;
  }
}

export function closeDeployMenu(target?: Element | null, restoreFocus = false): boolean {
  if (!deployMenuId || target?.closest(".deploy-menu")) return false;
  const id = deployMenuId;
  const restoreListFocus = !activeDeploy;
  deployMenuId = null;
  drawCurrentDeployView();
  if (restoreFocus && restoreListFocus) requestAnimationFrame(() => deploymentMenuTrigger(id)?.focus());
  return true;
}

export async function renderDeploys(): Promise<void> {
  if (appState.currentView !== "deploys") return;
  archiveCandidate = null;
  archiveFocusTarget = null;
  setDeployBackgroundInert(false);
  if (contextsState.selected) {
    deployScope = contextsState.selected;
    contextsState.selected = null;
  }
  const seq = appState.viewRenderSeq;
  await ensureContexts();
  deployLoading = deployList.length === 0;
  deployNotices = withDeploymentListNotice(deployNotices, "");
  drawDeploysPage();
  await refreshDeployments();
  if (seq !== appState.viewRenderSeq || appState.currentView !== "deploys") return;
  if (deploymentListRefreshCanRedraw(activeDeploy?.id)) drawDeploysPage();
}
