import { html, nothing, render, type TemplateResult } from "lit";
import {
  ArrowLeft,
  Box,
  Brain,
  ChevronDown,
  Clock,
  Files,
  Folder,
  KeyRound,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Rocket,
  type IconNode,
} from "lucide";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
  api,
  fetchRuntimeConfig,
  fetchTranscript,
  setSigninRequiredHandler,
  type SigninRequired,
  TAIL_TURNS,
  withBase,
} from "./core-bridge";
import { applyRuntimeOptions } from "./model-options";
import { errMessage, swallow } from "../../chassis/src/errors";
import { brandMark, brandName, icon, initials } from "./ui";
import {
  chatState,
  markConnectorConnected,
  mountContinuable,
  newChat,
  postCurrentPaneState,
  resetChatState,
  teardownActiveChat,
} from "./chat";
import { composerState, resetComposer, resyncModelSelection } from "./composer";
import { clearAllDrafts, saveDraft, storedDraft } from "./drafts";
import { deepLinkPath, parseDeepLink, UI_BASE } from "./deep-link";
import { embedMode } from "./embed";
import {
  addBlankPane,
  canvasToast,
  drawCanvas,
  exitSplitIfActive,
  loadPersistedSplit,
  mountRestoredCanvas,
  splitState,
} from "./split";
import { activityOf } from "./session-list";
import { replaceChildrenPreservingFocus } from "./pane-focus";
import {
  openSession,
  closeOpenSessionMenu,
  refreshSessions,
  renderChatsPage,
  renderList,
  resetSessionsState,
  sessionsState,
  toggleWebOnly,
} from "./sessions";
import { renderCronsPage, resetActiveCron } from "./crons";
import { renderFiles } from "./files";
import { clearConnectorNotice, noteConnectorResult, renderConnectors, resetKeychainState } from "./connectors";
import { renderDeploys } from "./deploys";
import { renderMemory, resetMemoryState } from "./memory";
import { renderSkills } from "./skills";
import { contextsState, ensureContexts, renderContexts, resetContextsState } from "./contexts";
import { appState, isView, type AuthMode, type Me, type View } from "./shell-state";
import { trapDialogFocus } from "./dialog-focus";
import { locale, t } from "./i18n";
export { appState, can, type Me, type View } from "./shell-state";

let authMode: AuthMode = "portal";
let shellMounted = false;

setSigninRequiredHandler((detail) => {
  authMode = detail.mode ?? authMode;
  renderAuthGate(gateFor(authMode, detail.reason));
});

export const ADMIN_BASE = (() => {
  const base = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");
  return base ? base.replace(/\/[^/]+$/, "/admin") : "/admin";
})();
export const ADMIN_HOME_URL = `${ADMIN_BASE}/`;

export function adminSessionLogUrl(sessionId: string, scopeId: string): string {
  const q = new URLSearchParams({ view: "history", scope: scopeId, session: sessionId });
  return `${ADMIN_BASE}/?${q.toString()}`;
}

export function syncUrlFromState(): void {
  if (embedMode) {
    postCurrentPaneState();
    if (parseDeepLink(UI_BASE, location.pathname, location.search).view === "app-edit") return;
    const sessionId = chatState.sessionId ?? chatState.rememberedSessionId;
    const next = sessionId ? `${deepLinkPath(UI_BASE, "chats", sessionId)}&embed=1` : `${UI_BASE}/?embed=1`;
    if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
    return;
  }
  const sessionId = splitState.active ? null : (chatState.sessionId ?? chatState.rememberedSessionId);
  const next = deepLinkPath(UI_BASE, appState.currentView, sessionId, contextsState.selected);
  if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
}

const appEl = document.getElementById("app");
if (!appEl) throw new Error("missing #app");

const narrowViewport = window.matchMedia("(max-width: 860px)");
let sidebarOpen = !narrowViewport.matches;

const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 520;
const SIDEBAR_W_KEY = "webui:sidebar-w";

function applySavedSidebarWidth(): void {
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
  if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W) {
    document.documentElement.style.setProperty("--sidebar-w", `${saved}px`);
  }
}

function startSidebarResize(e: PointerEvent): void {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const sidebar = (appEl as HTMLElement).querySelector<HTMLElement>(".sidebar");
  if (!sidebar) return;
  const startW = sidebar.getBoundingClientRect().width;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-sidebar");
  let w = startW;
  const onMove = (ev: PointerEvent) => {
    w = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + (ev.clientX - startX)));
    document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
  };
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("lostpointercapture", onUp);
    document.body.classList.remove("resizing-sidebar");
    localStorage.setItem(SIDEBAR_W_KEY, String(Math.round(w)));
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("lostpointercapture", onUp);
}

function resetSidebarWidth(): void {
  document.documentElement.style.removeProperty("--sidebar-w");
  localStorage.removeItem(SIDEBAR_W_KEY);
}

const NAV_WORKSPACE_KEY = "web-ui:nav-workspace";

function loadNavOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function saveNavOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    void 0;
  }
}

let navWorkspaceOpen = loadNavOpen(NAV_WORKSPACE_KEY);

function toggleNavWorkspace(): void {
  navWorkspaceOpen = !navWorkspaceOpen;
  saveNavOpen(NAV_WORKSPACE_KEY, navWorkspaceOpen);
  renderSidebarTop();
}

const ICON = {
  newChat: Plus,
  chats: MessageSquare,
  contexts: Folder,
  files: Files,
  keychain: KeyRound,
  deploys: Rocket,
  crons: Clock,
  memory: Brain,
  skills: Box,
};

export async function signOut(): Promise<void> {
  const portal = authMode === "portal";
  if (!portal) {
    try {
      await api("/signout", { method: "POST" });
    } catch {
      void 0;
    }
  }
  appState.me = null;
  clearAllDrafts();
  resetChatState();
  resetSessionsState();
  appState.currentView = "chats";
  composerState.skillsCache = null;
  resetMemoryState();
  resetContextsState();
  resetKeychainState();
  resetComposer();
  if (!portal) {
    renderAuthGate({ kind: "dev" });
    return;
  }
  let endedSession: boolean;
  try {
    const r = await fetch("/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    endedSession = r.ok;
  } catch {
    endedSession = false;
  }
  if (!endedSession) {
    renderAuthGate({ kind: "portal" });
    return;
  }
  clearPortalAttempt();
  location.href = "/";
}

export async function exitImpersonation(): Promise<void> {
  try {
    await fetch("/auth/impersonate/stop", { method: "POST", headers: { accept: "application/json" } });
  } catch {
    void 0;
  }
  window.location.href = ADMIN_HOME_URL;
}

function impersonationBanner(by: string) {
  return html`
    <div class="top-banner" role="status">
      <span>${t("auth.impersonation", { assistant: appState.me?.user ?? "", operator: by })}</span>
      <button class="top-banner-action" type="button" @click=${exitImpersonation}>
        ${t("auth.exitImpersonation")}
      </button>
    </div>
  `;
}

function devBanner(user: string) {
  return html`
    <div class="top-banner dev" role="status">
      <span><b>${t("auth.devMode")}</b> — ${t("auth.devModeStatus", { user })}</span>
      <button class="top-banner-action" type="button" @click=${signOut}>${t("signOut")}</button>
    </div>
  `;
}

function gateShell(body: unknown) {
  return html`
    <div class="signin">
      <div class="signin-panel">
        <div class="signin-brand">
          ${brandMark()}<span>${brandName()}</span>
          ${authMode === "dev" ? html`<span class="dev-chip">DEV</span>` : nothing}
        </div>
        ${body}
      </div>
    </div>
  `;
}

const PORTAL_ATTEMPT_KEY = "qm.portal.signin.attempt";
const PORTAL_ATTEMPT_WINDOW_MS = 20_000;

function portalAttemptedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(PORTAL_ATTEMPT_KEY) ?? "");
    return Number.isFinite(at) && Date.now() - at < PORTAL_ATTEMPT_WINDOW_MS;
  } catch {
    return false;
  }
}

function signInWithPortal(): void {
  try {
    sessionStorage.setItem(PORTAL_ATTEMPT_KEY, String(Date.now()));
  } catch {
    void 0;
  }
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function clearPortalAttempt(): void {
  try {
    sessionStorage.removeItem(PORTAL_ATTEMPT_KEY);
  } catch {
    void 0;
  }
}

function portalGate() {
  if (portalAttemptedRecently())
    return gateShell(html`
      <h1>${t("auth.portalTitle")}</h1>
      <p class="signin-body">${t("auth.portalBody")}</p>
      <div class="hint">${t("auth.portalHint")}</div>
    `);
  return gateShell(html`
    <h1>${t("auth.sessionEndedTitle")}</h1>
    <p class="signin-body">${t("auth.sessionEndedBody")}</p>
    <button class="btn primary" type="button" @click=${signInWithPortal}>${t("auth.signIn")}</button>
  `);
}

function deniedGate() {
  return gateShell(html`
    <h1>${t("auth.deniedTitle")}</h1>
    <p class="signin-body">${t("auth.deniedBody")}</p>
    <button class="btn" type="button" @click=${signOut}>${t("signOut")}</button>
    ${authMode === "dev" ? html`<div class="hint">${t("auth.devPrincipalsHint")}</div>` : nothing}
  `);
}

function retryBoot(): void {
  void bootSafely();
}

function unreachableGate() {
  return gateShell(html`
    <h1>${t("auth.unreachableTitle")}</h1>
    <p class="signin-body">${t("auth.unreachableBody")}</p>
    <button class="btn primary" type="button" @click=${retryBoot}>${t("auth.tryAgain")}</button>
    <div class="hint">${t("auth.unreachableHint")}</div>
  `);
}

async function submitDevSignin(user: string): Promise<void> {
  renderAuthGate({ kind: "dev", value: user, pending: true });
  try {
    await api("/signin", { method: "POST", body: JSON.stringify({ user }) });
  } catch (err) {
    renderAuthGate({ kind: "dev", value: user, error: errMessage(err, t("auth.signInFailed")) });
    return;
  }
  await bootSafely();
}

function devGate(gate: { value?: string; error?: string; pending?: boolean }) {
  return gateShell(html`
    <form
      @submit=${(e: Event) => {
        e.preventDefault();
        if (gate.pending) return;
        const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement | null;
        const user = input?.value.trim();
        if (user) void submitDevSignin(user);
      }}
    >
      <h1>${t("auth.devSigninTitle")}</h1>
      <p class="signin-body">${t("auth.devSigninBody")}</p>
      <label for="dev-principal">${t("auth.principal")}</label>
      <input
        id="dev-principal"
        name="principal"
        type="text"
        inputmode="email"
        autocomplete="username"
        spellcheck="false"
        required
        autofocus
        placeholder=${t("auth.principalPlaceholder")}
        .value=${gate.value ?? ""}
        ?disabled=${gate.pending === true}
      />
      <button class="btn primary" type="submit" ?disabled=${gate.pending === true}>
        ${gate.pending ? t("auth.signingIn") : t("auth.continue")}
      </button>
      ${gate.error ? html`<div class="hint error" role="alert">${gate.error}</div>` : nothing}
    </form>
  `);
}

export type AuthGate =
  | { kind: "portal" }
  | { kind: "denied" }
  | { kind: "unreachable" }
  | { kind: "dev"; value?: string; error?: string; pending?: boolean };

export function renderAuthGate(gate: AuthGate): void {
  shellMounted = false;
  const body = (() => {
    switch (gate.kind) {
      case "portal":
        return portalGate();
      case "denied":
        return deniedGate();
      case "unreachable":
        return unreachableGate();
      default:
        return devGate(gate);
    }
  })();
  render(body, appEl as HTMLElement);
}

function gateFor(mode: AuthMode, reason: "unauthenticated" | "not_allowed" | undefined): AuthGate {
  if (reason === "not_allowed") return { kind: "denied" };
  return mode === "dev" ? { kind: "dev" } : { kind: "portal" };
}

function setLocaleReturnTo(event: Event): void {
  const form = event.currentTarget as HTMLFormElement;
  const returnTo = form.elements.namedItem("returnTo");
  if (returnTo instanceof HTMLInputElement) returnTo.value = `${location.pathname}${location.search}${location.hash}`;
}

export function mountShell(): void {
  if (embedMode) {
    render(
      html`<div class="layout embed-layout">
        <section class="main" id="main"><div class="empty">${t("loading")}</div></section>
      </div>`,
      appEl as HTMLElement,
    );
    appState.topEl = null;
    appState.listEl = null;
    appState.mainEl = (appEl as HTMLElement).querySelector("#main");
    shellMounted = true;
    return;
  }
  applySavedSidebarWidth();
  const impersonatedBy = appState.me?.impersonatedBy ?? null;
  let banner: TemplateResult | null = null;
  if (impersonatedBy) banner = impersonationBanner(impersonatedBy);
  else if (authMode === "dev") banner = devBanner(appState.me?.user ?? "");
  render(
    html`
      ${banner ?? nothing}
      <div class="layout ${sidebarOpen ? "" : "sidebar-closed"} ${banner ? "bannered" : ""}">
        <aside class="sidebar" aria-label=${t("navigation")} @keydown=${onSidebarKeydown}>
          <div class="brand">
            <div class="brand-lockup">${brandMark()}<span class="brand-name">${brandName()}</span></div>
            <button
              class="icon-btn subtle sidebar-toggle sidebar-collapse-toggle"
              type="button"
              title=${t("sidebar.hide")}
              aria-label=${t("sidebar.hide")}
              @click=${toggleSidebar}
            >
              ${icon(PanelLeft, 17)}
            </button>
          </div>
          <div id="sidebar-top"></div>
          <div class="list" id="sidebar-body"></div>
          <div class="sidebar-footer">
            <div class="user-pill" title=${appState.me?.user ?? ""}>
              <span class="avatar">${initials(appState.me?.user ?? "?")}</span>
              <span class="user-name">${appState.me?.user ?? ""}</span>
            </div>
            <form class="language-form" action="/locale" method="post" @submit=${setLocaleReturnTo}>
              <label class="sr-only" for="web-ui-locale">${t("language")}</label>
              <select
                id="web-ui-locale"
                name="locale"
                aria-label=${t("language")}
                .value=${locale()}
                @change=${(event: Event) => (event.currentTarget as HTMLSelectElement).form?.requestSubmit()}
              >
                <option value="en">${t("english")}</option>
                <option value="ja">${t("japanese")}</option>
              </select>
              <input type="hidden" name="returnTo" value="" />
            </form>
            <a
              class="icon-btn subtle"
              href=${ADMIN_HOME_URL}
              title=${t("sidebar.backToAdmin")}
              aria-label=${t("sidebar.backToAdmin")}
              >${icon(ArrowLeft, 17)}</a
            >
            <theme-toggle></theme-toggle>
            <button class="icon-btn subtle" title=${t("signOut")} aria-label=${t("signOut")} @click=${signOut}>
              ${icon(LogOut, 17)}
            </button>
          </div>
        </aside>
        <button class="sidebar-scrim" type="button" aria-label=${t("sidebar.close")} @click=${toggleSidebar}></button>
        <div
          class="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label=${t("sidebar.resize")}
          title=${t("sidebar.resizeHint")}
          @pointerdown=${startSidebarResize}
          @dblclick=${resetSidebarWidth}
        ></div>
        <section class="main" id="main" tabindex="-1">
          <div class="empty">${t("sidebar.empty")}</div>
        </section>
      </div>
    `,
    appEl as HTMLElement,
  );
  appState.topEl = (appEl as HTMLElement).querySelector("#sidebar-top");
  appState.listEl = (appEl as HTMLElement).querySelector("#sidebar-body");
  appState.mainEl = (appEl as HTMLElement).querySelector("#main");
  renderSidebarTop();
  updateSidebarToggleLabels();
  syncSidebarAccessibility(false);
  shellMounted = true;
}

export function renderSidebarTop(): void {
  if (!appState.topEl) return;
  const navRow = (v: View, glyph: IconNode, label: string) =>
    html`<button class="navrow ${appState.currentView === v ? "active" : ""}" type="button" data-view=${v}>
      ${icon(glyph, 17)}<span>${label}</span>
    </button>`;
  const navGroup = (id: string, title: string, open: boolean, toggle: () => void, rows: TemplateResult) => html`
    <button
      class="nav-section-toggle"
      type="button"
      aria-expanded=${open ? "true" : "false"}
      aria-controls=${id}
      title=${t(open ? "nav.hideSection" : "nav.showSection", { section: title })}
      @click=${toggle}
    >
      <span>${title}</span>
      <span class="nav-section-chevron">${icon(ChevronDown, 14)}</span>
    </button>
    <div id=${id} class="nav-group ${open ? "" : "collapsed"}">
      <div class="nav-group-inner">${rows}</div>
    </div>
  `;
  render(
    html`
      <button
        class="new-chat"
        @click=${() => {
          closeSidebarOnNarrowView();
          if (!addBlankPane()) newChat();
        }}
      >
        ${icon(ICON.newChat, 17)}<span>${t(splitState.active ? "chat.newSession" : "chat.new")}</span>
      </button>
      <nav class="nav" @click=${onNavClick}>
        ${navGroup(
          "nav-workspace",
          t("nav.browse"),
          navWorkspaceOpen,
          toggleNavWorkspace,
          html`
            ${navRow("contexts", ICON.contexts, t("nav.projects"))} ${navRow("chats", ICON.chats, t("nav.chats"))}
            ${navRow("files", ICON.files, t("nav.files"))} ${navRow("crons", ICON.crons, t("nav.crons"))}
            ${navRow("keychain", ICON.keychain, t("nav.keychain"))} ${navRow("deploys", ICON.deploys, t("nav.apps"))}
            ${navRow("memory", ICON.memory, t("nav.memory"))} ${navRow("skills", ICON.skills, t("nav.skills"))}
          `,
        )}
      </nav>
      ${
        appState.currentView === "chats"
          ? html`
              <div class="section-label recents-label">
                <span>${t("nav.sessions")}</span>
                <button
                  class="web-only-toggle ${sessionsState.webOnly ? "on" : ""}"
                  type="button"
                  role="switch"
                  aria-checked=${sessionsState.webOnly ? "true" : "false"}
                  title=${t(sessionsState.webOnly ? "nav.showingWebOnly" : "nav.hideNonWeb")}
                  @click=${toggleWebOnly}
                >
                  <span>${t("nav.webOnly")}</span><span class="mini-switch"><span class="mini-knob"></span></span>
                </button>
              </div>
            `
          : ""
      }
    `,
    appState.topEl,
  );
}

function onNavClick(e: Event): void {
  const target = e.target as Element | null;
  const row = target?.closest<HTMLButtonElement>(".navrow[data-view]");
  const view = row?.dataset.view;
  if (isView(view)) {
    switchView(view);
    closeSidebarOnNarrowView();
  }
}

export function switchView(v: View): void {
  closeSidebarOnNarrowView();
  if (appState.currentView === v) {
    refreshActiveView(v);
    return;
  }
  appState.currentView = v;
  appState.viewRenderSeq++;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  if (v !== "chats") {
    teardownActiveChat();
    resetComposer();
  }
  renderSidebarTop();
  syncUrlFromState();
  if (v !== "chats" && appState.listEl) render(nothing, appState.listEl);
  switch (v) {
    case "chats":
      if (splitState.active) drawCanvas();
      else void renderChatsPage();
      renderList();
      break;
    case "crons":
      resetActiveCron();
      void renderCronsPage();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
  }
}

function refreshActiveView(v: View): void {
  switch (v) {
    case "chats":
      if (splitState.active) void refreshSessions({ silent: true, refreshContexts: true });
      else void renderChatsPage();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "crons":
      void renderCronsPage();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      clearConnectorNotice();
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
  }
}

export function showMainEmpty(text: string): void {
  exitSplitIfActive();
  chatState.host = null;
  if (appState.mainEl)
    appState.mainEl.replaceChildren(
      Object.assign(document.createElement("div"), { className: "empty", textContent: text }),
    );
}

function toggleSidebar(): void {
  setSidebarOpen(!sidebarOpen);
}

export function closeSidebarOnNarrowView(): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  setSidebarOpen(false, false);
  requestAnimationFrame(() => appState.mainEl?.focus({ preventScroll: true }));
}

narrowViewport.addEventListener("change", (event) => {
  if (event.matches && sidebarOpen) setSidebarOpen(false, false);
  else syncSidebarAccessibility(false);
});

function setSidebarOpen(open: boolean, moveFocus = true): void {
  sidebarOpen = open;
  (appEl as HTMLElement).querySelector(".layout")?.classList.toggle("sidebar-closed", !sidebarOpen);
  updateSidebarToggleLabels();
  syncSidebarAccessibility(moveFocus);
}

function syncSidebarAccessibility(moveFocus: boolean): void {
  const root = appEl as HTMLElement;
  const sidebar = root.querySelector<HTMLElement>(".sidebar");
  const main = root.querySelector<HTMLElement>(".main");
  const scrim = root.querySelector<HTMLButtonElement>(".sidebar-scrim");
  const modal = narrowViewport.matches && sidebarOpen;
  if (!sidebar || !main || !scrim) return;
  main.inert = modal;
  sidebar.setAttribute("role", modal ? "dialog" : "navigation");
  if (modal) sidebar.setAttribute("aria-modal", "true");
  else sidebar.removeAttribute("aria-modal");
  scrim.hidden = !modal;
  if (!moveFocus || !narrowViewport.matches) return;
  requestAnimationFrame(() => sidebar.querySelector<HTMLElement>(".sidebar-collapse-toggle")?.focus());
}

function onSidebarKeydown(event: KeyboardEvent): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  if (event.key === "Escape" && event.defaultPrevented) return;
  if (event.key === "Escape" && closeOpenSessionMenu()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  trapDialogFocus(event, () => setSidebarOpen(false));
}

function updateSidebarToggleLabels(): void {
  const collapseLabel = t(sidebarOpen ? "sidebar.hide" : "sidebar.show");
  (appEl as HTMLElement).querySelectorAll<HTMLButtonElement>(".sidebar-toggle").forEach((btn) => {
    btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
    btn.setAttribute("title", collapseLabel);
    btn.setAttribute("aria-label", collapseLabel);
  });
}

export function renderPane(
  title: string,
  status: string,
  onRefresh: () => void,
  cards: unknown,
  controls: unknown = "",
): void {
  if (!appState.mainEl) return;
  const refreshLabel = t("common.refreshNamed", { name: title });
  const host = document.createElement("div");
  host.className = "pane";
  render(
    html`
      <div class="pane-head">
        <h1 class="pane-title">${title}</h1>
        <div class="list-page-actions">
          ${controls}
          <button
            class="pane-refresh"
            type="button"
            aria-label=${refreshLabel}
            title=${refreshLabel}
            @click=${onRefresh}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${status ? html`<div class="status">${status}</div>` : ""}
      <div class="grid">${cards}</div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export function replacePanePreservingFocus(host: HTMLElement): void {
  if (!appState.mainEl) return;
  replaceChildrenPreservingFocus(appState.mainEl, host);
}

window.addEventListener("focus", () => {
  if (!appState.me || embedMode) return;
  if (appState.currentView === "contexts") void renderContexts();
  else if (appState.currentView === "chats") void refreshSessions({ silent: true, refreshContexts: true });
});

function warmDeferredChunks(): void {
  const warm = (): void => void import("@earendil-works/pi-web-ui").catch(() => {});
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(warm);
  else setTimeout(warm, 1500);
}

function openAppEditChat(slug: string): void {
  const user = appState.me?.user ?? "anon";
  const threadRef = `web:${user}:app-edit:${slug}`;
  const existing = sessionsState.list.find((s) => s.threadRef === threadRef);
  if (existing) {
    void openSession(existing);
    return;
  }
  if (!storedDraft(threadRef)) saveDraft(threadRef, `Update my deployed app "${slug}": `);
  mountContinuable(threadRef, null, null, []);
  renderList();
}

export async function bootSafely(): Promise<void> {
  try {
    await boot();
  } catch (e) {
    if (shellMounted) swallow("web-ui: boot", e);
    else renderAuthGate({ kind: "unreachable" });
  }
}

export async function boot(): Promise<void> {
  let r: Response;
  try {
    r = await fetch(withBase("/me"));
  } catch {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  if (r.status === 401) {
    const body = (await r.json().catch(() => ({}))) as SigninRequired;
    authMode = body.mode ?? "portal";
    renderAuthGate(gateFor(authMode, body.reason));
    return;
  }
  if (!r.ok) {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  resetKeychainState();
  appState.me = (await r.json()) as Me;
  authMode = appState.me.mode ?? "portal";
  clearPortalAttempt();
  const runtimeConfig = await fetchRuntimeConfig(`personal:${appState.me.user}`);
  if (runtimeConfig)
    applyRuntimeOptions(
      runtimeConfig.approvedHarnesses,
      runtimeConfig.modelsByHarness,
      runtimeConfig.effective,
      runtimeConfig.modelCatalog,
    );
  resyncModelSelection();
  mountShell();
  warmDeferredChunks();
  loadPersistedSplit();

  const params = new URLSearchParams(location.search);
  const { view: wanted, session: wantedSession } = parseDeepLink(UI_BASE, location.pathname, location.search);
  const connectedProvider = params.get("status") === "connected" ? params.get("connector") : null;
  if (connectedProvider) markConnectorConnected(connectedProvider);
  const viewIntent = isView(wanted) && wanted !== "chats";
  const entriesPrefetch =
    wantedSession && !viewIntent ? fetchTranscript(wantedSession, { tailTurns: TAIL_TURNS }).catch(() => null) : null;

  await refreshSessions({ showLoading: true });

  if (wanted === "app-edit") {
    const slug = (params.get("slug") ?? "").toLowerCase();
    if (/^[a-z0-9-]{1,63}$/.test(slug)) {
      openAppEditChat(slug);
      return;
    }
    showMainEmpty(t("shell.invalidAppLink"));
    return;
  }

  if (embedMode) {
    if (wantedSession) {
      const match = sessionsState.list.find((s) => s.id === wantedSession);
      if (match) await openSession(match, entriesPrefetch ?? undefined);
      else showMainEmpty(t("shell.conversationNotFound"));
    } else {
      const scope = params.get("scope");
      const context = scope ? (await ensureContexts()).find((c) => c.scopeId === scope) : undefined;
      newChat(context ? { scopeId: context.scopeId, name: context.name ?? null } : undefined);
    }
    return;
  }

  if (wanted === "keychain") {
    const provider = params.get("connector");
    const status = params.get("status");
    if (provider && status) noteConnectorResult(provider, status);
    switchView("keychain");
  } else if (viewIntent) {
    if (wanted === "contexts" || wanted === "files" || wanted === "deploys") {
      const scope = params.get("scope");
      if (scope) contextsState.selected = scope;
    }
    switchView(wanted as View);
  } else if (wantedSession) {
    const match = sessionsState.list.find((s) => s.id === wantedSession);
    if (match) {
      exitSplitIfActive();
      await openSession(match, entriesPrefetch ?? undefined);
    } else if (mountRestoredCanvas()) {
      canvasToast(t("shell.conversationNotFound"));
      syncUrlFromState();
    } else {
      showMainEmpty(t("shell.conversationNotFound"));
      renderList();
    }
  } else if (connectedProvider && sessionsState.list.length) {
    const recent = [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a))[0]!;
    exitSplitIfActive();
    await openSession(recent);
  } else if (!mountRestoredCanvas()) {
    newChat();
  }
}
