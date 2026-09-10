import { openModelConnectManager, renderModelConnectGate } from "./model-connect";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Box,
  Brain,
  Clock,
  Files,
  Folder,
  House,
  Inbox as InboxGlyph,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeft,
  Plus,
  Repeat,
  Rocket,
  Search,
  Settings,
  ShieldUser,
  Webhook,
  type IconNode,
} from "lucide";
import {
  api,
  setSigninRequiredHandler,
  type SigninRequired,
  fetchRuntimeConfig,
  fetchSessionApprovals,
  fetchTranscript,
  TAIL_TURNS,
  webFetch,
  withBase,
} from "./core-bridge";
import { applyRuntimeOptions } from "./model-options";
import { errMessage, swallow } from "../../chassis/src/errors";
import { brandMark, brandName, icon } from "./ui";
import { PHONE_MAX_WIDTH, trackVisualViewport } from "./viewport";
import { markConnectorConnected } from "./chat";
import { clearSkillsCache, resyncModelSelection, seedRuntimeConfig } from "./composer";
import { ensureDeliveryStream, mainConversation, onExitCanvas } from "./conversations";
import { clearAllDrafts, saveDraft, storedDraft } from "./drafts";
import { deepLinkPath, isPlainLeftClick, parseDeepLink, UI_BASE } from "./deep-link";
import {
  adoptRemoteSplit,
  canvasToast,
  beginPaneKindDrag,
  drawCanvas,
  endPaneDrag,
  exitSplitIfActive,
  fetchRemoteSplit,
  focusedPaneSession,
  loadPersistedSplit,
  mountRestoredCanvas,
  restoredCanvasNeedsSessionList,
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
  sessionTitle,
  sessionsState,
  sessionSelectionBar,
  revealSessionSurface,
  startNewChatInLastScope,
  startNewChat,
} from "./sessions";
import { openCronById, renderCronsPage, resetActiveCron, routeCronsHistory } from "./crons";
import { renderLoopsPage, resetActiveLoop } from "./loops";
import { openWebhookById, renderWebhooksPage, resetActiveWebhook, routeWebhooksHistory } from "./webhooks";
import { renderFiles } from "./files";
import { setScopedSession } from "./session-scope";
import { openChatSearch } from "./search";
import { closeBrowse, openBrowse } from "./browse";
import { attachTooltip, hideTooltip, tip } from "./tooltip";
import { clearConnectorNotice, noteConnectorResult, renderConnectors, resetKeychainState } from "./connectors";
import { renderDeploys } from "./deploys";
import { renderMemory, resetMemoryState } from "./memory";
import {
  inboxOpenCount,
  openInboxItemById,
  refreshInbox,
  renderInbox,
  resetActiveInboxItem,
  resetInboxState,
  routeInboxHistory,
} from "./inbox";
import { openSkillById, renderSkills, resetActiveSkill, routeSkillsHistory } from "./skills";
import { applyTheme, renderSettings, watchSystemTheme } from "./settings";
import { contextsState, ensureContexts, renderContexts, resetContextsState, resolveProjectScope } from "./contexts";
import { appState, can, canView, isView, type AuthMode, type Me, type View } from "./shell-state";
import { trapDialogFocus } from "./dialog-focus";
import { activeSessionForDocumentTitle, updateDocumentTitle } from "./document-title";
export { appState, can, type Me, type View } from "./shell-state";

let userMenuOpen = false;
let footerEl: HTMLElement | null = null;

applyTheme();
watchSystemTheme();

function toggleUserMenu(e: Event): void {
  e.stopPropagation();
  userMenuOpen = !userMenuOpen;
  renderSidebarFooter();
}

export function closeUserMenu(): void {
  if (!userMenuOpen) return;
  userMenuOpen = false;
  renderSidebarFooter();
}

function signOutFromMenu(): void {
  userMenuOpen = false;
  renderSidebarFooter();
  void signOut();
}

let authMode: AuthMode = "portal";
let shellMounted = false;

setSigninRequiredHandler((detail) => {
  authMode = detail.mode ?? authMode;
  renderAuthGate(gateFor(authMode, detail.reason));
});

onExitCanvas(() => exitSplitIfActive());

export const ADMIN_BASE = (() => {
  const base = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");
  return base ? base.replace(/\/[^/]+$/, "/admin") : "/admin";
})();
export const ADMIN_HOME_URL = `${ADMIN_BASE}/`;

export function syncUrlFromState(sessionOverride?: string | null): void {
  const chatState = mainConversation().state;
  const fromState =
    sessionOverride !== undefined ? sessionOverride : (chatState.sessionId ?? chatState.rememberedSessionId);
  const sessionId = splitState.active ? null : fromState;
  const next = deepLinkPath(UI_BASE, appState.currentView, sessionId, contextsState.selected);
  if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
}

const appEl = document.getElementById("app");
if (!appEl) throw new Error("missing #app");

const narrowViewport = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);
let sidebarOpen = !narrowViewport.matches;
trackVisualViewport();

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

const ICON = {
  newChat: Plus,
  inbox: InboxGlyph,
  chats: MessageSquare,
  contexts: Folder,
  files: Files,
  keychain: KeyRound,
  deploys: Rocket,
  webhooks: Webhook,
  crons: Clock,
  loops: Repeat,
  memory: Brain,
  skills: Box,
  home: House,
  browse: LayoutGrid,
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
  closeBrowse();
  resetInboxState();
  clearAllDrafts();
  exitSplitIfActive();
  mainConversation().resetChatState();
  resetSessionsState();
  appState.currentView = "chats";
  clearSkillsCache();
  resetMemoryState();
  resetContextsState();
  resetKeychainState();
  mainConversation().composer.resetComposer();
  updateDocumentTitle();
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
    <div class="impersonation-banner" role="status">
      <span class="impersonation-banner-text"
        >Viewing the assistant as <b>${appState.me?.user ?? ""}</b>. You are <b>${by}</b></span
      >
      <button class="impersonation-banner-exit" type="button" @click=${exitImpersonation}>Exit impersonation</button>
    </div>
  `;
}

function devBanner(user: string) {
  return html`
    <div class="top-banner dev" role="status">
      <span><b>Dev mode</b> — no identity provider, signed in as ${user}</span>
      <button class="top-banner-action" type="button" @click=${signOut}>Sign out</button>
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
      <h1>Sign in through the portal</h1>
      <p class="signin-body">
        This surface is reached through the portal, and signing in there didn't produce a session for it. Open the
        portal address directly rather than this one.
      </p>
      <div class="hint">
        If you opened this surface's own address, that's the cause — it can't authenticate anyone on its own.
      </div>
    `);
  return gateShell(html`
    <h1>Your session ended</h1>
    <p class="signin-body">You've been signed out. Sign in again and you'll come back to this page.</p>
    <button class="btn primary" type="button" @click=${signInWithPortal}>Sign in</button>
  `);
}

function deniedGate() {
  return gateShell(html`
    <h1>You don't have access</h1>
    <p class="signin-body">
      Your account is signed in and verified — it just isn't allowed on this instance. Ask an administrator to add you.
    </p>
    <button class="btn" type="button" @click=${signOut}>Sign out</button>
    ${
      authMode === "dev"
        ? html`<div class="hint">This instance lists its principals in <b>WEB_UI_PRINCIPALS</b>.</div>`
        : nothing
    }
  `);
}

function retryBoot(): void {
  void bootSafely();
}

function unreachableGate() {
  return gateShell(html`
    <h1>We couldn't reach the assistant</h1>
    <p class="signin-body">The service didn't respond. This is usually temporary.</p>
    <button class="btn primary" type="button" @click=${retryBoot}>Try again</button>
    <div class="hint">If this keeps happening, the core service may be down.</div>
  `);
}

async function submitDevSignin(user: string): Promise<void> {
  renderAuthGate({ kind: "dev", value: user, pending: true });
  try {
    await api("/signin", { method: "POST", body: JSON.stringify({ user }) });
  } catch (err) {
    renderAuthGate({ kind: "dev", value: user, error: errMessage(err, "Sign-in failed.") });
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
      <h1>Dev sign-in</h1>
      <p class="signin-body">
        No identity provider is configured, so this instance trusts a local cookie. Set
        <b>CORE_SIGNING_SECRET</b> and run the portal to use real sign-in.
      </p>
      <label for="dev-principal">Principal</label>
      <input
        id="dev-principal"
        name="principal"
        type="text"
        inputmode="email"
        autocomplete="username"
        spellcheck="false"
        required
        autofocus
        placeholder="you@org.com"
        .value=${gate.value ?? ""}
        ?disabled=${gate.pending === true}
      />
      <button class="btn primary" type="submit" ?disabled=${gate.pending === true}>
        ${gate.pending ? "Signing in…" : "Continue"}
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

export function mountShell(): void {
  applySavedSidebarWidth();
  const impersonatedBy = appState.me?.impersonatedBy ?? null;
  let banner: TemplateResult | typeof nothing = nothing;
  if (impersonatedBy) banner = impersonationBanner(impersonatedBy);
  else if (authMode === "dev") banner = devBanner(appState.me?.user ?? "");
  render(
    html`
      ${banner}
      <div class="layout ${sidebarOpen ? "" : "sidebar-closed"} ${banner !== nothing ? "bannered" : ""}">
        <aside
          class="sidebar"
          aria-label="Navigation"
          data-tip-placement=${sidebarOpen ? "top" : "right"}
          @keydown=${onSidebarKeydown}
        >
          <div class="brand">
            <div class="brand-lockup">${brandMark()}<span class="brand-name">${brandName()}</span></div>
            <button
              class="icon-btn sidebar-toggle sidebar-collapse-toggle"
              type="button"
              aria-label=${sidebarToggleLabel()}
              ${tip(sidebarToggleLabel())}
              @click=${toggleSidebar}
            >
              ${icon(PanelLeft, 17)}
            </button>
          </div>
          <div id="sidebar-top"></div>
          <div class="list" id="sidebar-body"></div>
          <div class="sidebar-footer" id="sidebar-footer"></div>
        </aside>
        <button class="sidebar-scrim" type="button" aria-label="Close sidebar" @click=${toggleSidebar}></button>
        <div
          class="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          ${tip("Drag to resize · double-click to reset")}
          @pointerdown=${startSidebarResize}
          @dblclick=${resetSidebarWidth}
        ></div>
        <button
          class="icon-btn sidebar-toggle mobile-menu-btn"
          type="button"
          aria-label=${sidebarToggleLabel()}
          @click=${toggleSidebar}
        >
          ${icon(Menu, 20)}
        </button>
        <section class="main" id="main" tabindex="-1">
          <div class="empty">Pick a conversation, or start a new chat.</div>
        </section>
      </div>
    `,
    appEl as HTMLElement,
  );
  appState.topEl = (appEl as HTMLElement).querySelector("#sidebar-top");
  appState.listEl = (appEl as HTMLElement).querySelector("#sidebar-body");
  appState.mainEl = (appEl as HTMLElement).querySelector("#main");
  footerEl = (appEl as HTMLElement).querySelector("#sidebar-footer");
  renderSidebarFooter();
  renderSidebarTop();
  updateSidebarToggleLabels();
  syncSidebarAccessibility(false);
}

function inboxNavRow(): TemplateResult {
  const count = inboxOpenCount();
  return html`<a
    class="navrow ${appState.currentView === "inbox" ? "active" : ""}"
    href=${deepLinkPath(UI_BASE, "inbox", null)}
    data-view="inbox"
    draggable="true"
    @dragstart=${(e: DragEvent) => {
      e.dataTransfer?.setData("application/x-webui-inbox", "all");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      beginPaneKindDrag("inboxView", "all");
    }}
    @dragend=${() => endPaneDrag()}
  >
    ${icon(ICON.inbox, 17)}<span>Inbox</span>${count > 0 ? html`<span class="nav-badge" aria-label=${`${count} waiting on you`}>${count > 99 ? "99+" : count}</span>` : nothing}
  </a>`;
}

export function renderSidebarFooter(): void {
  if (!footerEl) return;
  render(
    html`
      <div class="user-menu ${userMenuOpen ? "menu-open" : ""}">
        <button
          class="user-pill"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${userMenuOpen ? "true" : "false"}
          @click=${toggleUserMenu}
        >
          <span class="user-name">${appState.me?.user ?? ""}</span>
        </button>
        ${
          userMenuOpen
            ? html`<div class="session-menu-popover user-menu-popover" role="menu">
                ${appState.me?.individualModelAuth ? html`<button class="session-menu-option" type="button" role="menuitem" @click=${openModelConnectManager}>Manage AI account</button>` : nothing}
                <button class="session-menu-option" type="button" role="menuitem" @click=${signOutFromMenu}>
                  ${icon(LogOut, 15)}<span>Sign out</span>
                </button>
              </div>`
            : nothing
        }
      </div>
      ${
        can("admin")
          ? html`<a class="icon-btn subtle" href=${ADMIN_HOME_URL} aria-label="Admin" ${tip("Admin")}>
              ${icon(ShieldUser, 17)}
            </a>`
          : nothing
      }
      <button class="icon-btn subtle" aria-label="Settings" ${tip("Settings")} @click=${() => switchView("settings")}>
        ${icon(Settings, 17)}
      </button>
    `,
    footerEl,
  );
}

export function renderSidebarTop(): void {
  syncDocumentTitle();
  if (!appState.topEl) return;
  const highlighted = (v: View) => v !== "chats" && appState.currentView === v;
  const navRow = (v: View, glyph: IconNode, label: string) =>
    html`<a
      class="navrow ${highlighted(v) ? "active" : ""}"
      href=${deepLinkPath(UI_BASE, v, null)}
      data-view=${v}
      aria-label=${label}
      ${tip(sidebarOpen ? "" : label)}
    >
      ${icon(glyph, 17)}<span>${label}</span>
    </a>`;
  const actionRow = (glyph: IconNode, label: string, run: () => void) =>
    html`<button
      class="navrow"
      type="button"
      aria-label=${label}
      ${tip(sidebarOpen ? "" : label)}
      @click=${() => {
        closeSidebarOnNarrowView();
        run();
      }}
    >
      ${icon(glyph, 17)}<span>${label}</span>
    </button>`;
  const newChatLabel = splitState.active ? "New session" : "Create New Chat";
  render(
    html`
      <nav class="nav quick-nav" @click=${onNavClick}>
        ${navRow("chats", ICON.home, "Home")} ${can("inbox") ? inboxNavRow() : nothing}
        ${actionRow(Search, "Search", () => {
          hideTooltip();
          openChatSearch();
        })}
        ${actionRow(ICON.browse, "Browse", () => {
          hideTooltip();
          openBrowse();
        })}
      </nav>
      <div class="nav new-chat-nav">
        ${actionRow(ICON.newChat, newChatLabel, () => {
          hideTooltip();
          startNewChatInLastScope();
        })}
      </div>
      ${sessionSelectionBar() ?? html` <div class="section-label recents-label"><span>Sessions</span></div> `}
    `,
    appState.topEl,
  );
}

export function syncDocumentTitle(): void {
  if (!appState.me) {
    updateDocumentTitle();
    return;
  }
  const state = mainConversation().state;
  const active = splitState.active
    ? focusedPaneSession()
    : activeSessionForDocumentTitle(sessionsState.list, {
        openingKey: sessionsState.openingKey,
        sessionId: state.sessionId,
        threadRef: state.threadRef,
      });
  updateDocumentTitle(
    appState.currentView,
    active ? sessionTitle(active) : null,
    Boolean(active || (!splitState.active && state.threadRef)),
  );
}

function onNavClick(e: Event): void {
  const target = e.target as Element | null;
  const row = target?.closest<HTMLAnchorElement>(".navrow[data-view]");
  const view = row?.dataset.view;
  if (!isView(view)) return;
  if (e instanceof MouseEvent && !isPlainLeftClick(e)) return;
  e.preventDefault();
  setScopedSession(null);
  switchView(view);
  closeSidebarOnNarrowView();
}

export function switchView(v: View): void {
  if (!canView(v)) v = "chats";
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
    mainConversation().teardown();
    mainConversation().composer.resetComposer();
  }
  renderSidebarTop();
  syncUrlFromState();
  resetActiveDetail(v);
  switch (v) {
    case "chats":
      if (splitState.active) drawCanvas();
      else void renderChatsPage();
      renderList();
      break;
    case "inbox":
      void renderInbox();
      break;
    case "webhooks":
      void renderWebhooksPage();
      break;
    case "crons":
      void renderCronsPage();
      break;
    case "loops":
      void renderLoopsPage();
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
    case "settings":
      renderSettings();
      break;
  }
}

function resetActiveDetail(v: View): void {
  switch (v) {
    case "inbox":
      resetActiveInboxItem();
      break;
    case "webhooks":
      resetActiveWebhook();
      break;
    case "crons":
      resetActiveCron();
      break;
    case "loops":
      resetActiveLoop();
      break;
    case "skills":
      resetActiveSkill();
      break;
  }
}

function refreshActiveView(v: View): void {
  resetActiveDetail(v);
  syncUrlFromState();
  switch (v) {
    case "chats":
      if (splitState.active) void refreshSessions({ silent: true, refreshContexts: true });
      else void renderChatsPage();
      break;
    case "inbox":
      void renderInbox();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "webhooks":
      void renderWebhooksPage();
      break;
    case "crons":
      void renderCronsPage();
      break;
    case "loops":
      void renderLoopsPage();
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
    case "settings":
      renderSettings();
      break;
  }
}

export function showMainEmpty(text: string): void {
  exitSplitIfActive();
  mainConversation().state.host = null;
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

const EDGE_PX = 28;
const SWIPE_PX = 56;
let swipe: { x: number; y: number; fromEdge: boolean; onDrawer: boolean } | null = null;
appEl.addEventListener(
  "touchstart",
  (e) => {
    if (!narrowViewport.matches || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const target = e.target as Element | null;
    const onDrawer = Boolean(target?.closest(".sidebar, .sidebar-scrim"));
    const fromEdge = !sidebarOpen && t.clientX <= EDGE_PX;
    if (!fromEdge && !(sidebarOpen && onDrawer)) return;
    swipe = { x: t.clientX, y: t.clientY, fromEdge, onDrawer };
  },
  { passive: true },
);
appEl.addEventListener(
  "touchend",
  (e) => {
    if (!swipe) return;
    const t = e.changedTouches[0];
    const s = swipe;
    swipe = null;
    if (!t) return;
    const dx = t.clientX - s.x;
    const dy = Math.abs(t.clientY - s.y);
    if (Math.abs(dx) < SWIPE_PX || dy > Math.abs(dx) * 0.8) return;
    if (s.fromEdge && dx > 0 && !sidebarOpen) setSidebarOpen(true);
    else if (s.onDrawer && dx < 0 && sidebarOpen) setSidebarOpen(false, false);
  },
  { passive: true },
);
appEl.addEventListener("touchcancel", () => (swipe = null), { passive: true });

narrowViewport.addEventListener("change", (event) => {
  if (event.matches && sidebarOpen) setSidebarOpen(false, false);
  else syncSidebarAccessibility(false);
});

function setSidebarOpen(open: boolean, moveFocus = true): void {
  if (open && narrowViewport.matches) document.dispatchEvent(new CustomEvent("qm:close-overlays"));
  sidebarOpen = open;
  (appEl as HTMLElement).querySelector(".layout")?.classList.toggle("sidebar-closed", !sidebarOpen);
  (appEl as HTMLElement).querySelector(".sidebar")?.setAttribute("data-tip-placement", open ? "top" : "right");
  updateSidebarToggleLabels();
  renderSidebarTop();
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

  const next = sidebarOpen
    ? sidebar.querySelector<HTMLElement>(".sidebar-collapse-toggle")
    : root.querySelector<HTMLElement>(".mobile-menu-btn");
  requestAnimationFrame(() => next?.focus());
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

function sidebarToggleLabel(): string {
  return sidebarOpen ? "Hide sidebar" : "Show sidebar";
}

function updateSidebarToggleLabels(): void {
  const collapseLabel = sidebarToggleLabel();
  (appEl as HTMLElement).querySelectorAll<HTMLButtonElement>(".sidebar-toggle").forEach((btn) => {
    btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
    btn.setAttribute("aria-label", collapseLabel);
    attachTooltip(btn, collapseLabel);
  });
}

export function replacePanePreservingFocus(host: HTMLElement): void {
  if (!appState.mainEl) return;
  replaceChildrenPreservingFocus(appState.mainEl, host);
}

window.addEventListener("popstate", () => {
  const routed = ["crons", "webhooks", "inbox", "skills"];
  if (!routed.includes(appState.currentView)) return;
  const { view, item } = parseDeepLink(UI_BASE, location.pathname, location.search);
  if (view !== appState.currentView) return;
  if (view === "crons") routeCronsHistory(item);
  else if (view === "webhooks") routeWebhooksHistory(item);
  else if (view === "skills") routeSkillsHistory(item);
  else routeInboxHistory(item);
});

window.addEventListener("focus", () => {
  if (!appState.me) return;
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
  startNewChat(null, null, threadRef);
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
  const params = new URLSearchParams(location.search);
  const {
    view: wanted,
    session: wantedSession,
    item: wantedItem,
  } = parseDeepLink(UI_BASE, location.pathname, location.search);
  const chatsLink = wanted === null || wanted === "chats";
  const linkedId = wantedSession && chatsLink ? wantedSession : null;
  const entriesPrefetch = linkedId ? fetchTranscript(linkedId, { tailTurns: TAIL_TURNS }).catch(() => null) : null;
  const approvalsPrefetch = linkedId ? fetchSessionApprovals(linkedId) : null;
  const runtimeConfigFetch = fetchRuntimeConfig();
  const remoteSplitFetch = fetchRemoteSplit();

  let r: Response;
  try {
    r = await webFetch(withBase("/me"));
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
  if (appState.me.individualModelAuth && !appState.me.modelAuthConnected) {
    shellMounted = false;
    renderModelConnectGate();
    return;
  }
  const personalScope = `personal:${appState.me.user}`;
  const prefetchedConfig = await runtimeConfigFetch;
  const runtimeConfig =
    prefetchedConfig?.scopeId === personalScope ? prefetchedConfig : await fetchRuntimeConfig(personalScope);
  if (runtimeConfig) {
    applyRuntimeOptions(
      personalScope,
      runtimeConfig.approvedHarnesses,
      runtimeConfig.modelsByHarness,
      runtimeConfig.effective,
      runtimeConfig.modelCatalog,
    );
    seedRuntimeConfig(personalScope, runtimeConfig);
  }
  resyncModelSelection();
  mountShell();
  shellMounted = true;
  ensureDeliveryStream();
  warmDeferredChunks();
  void refreshInbox({ silent: true });
  loadPersistedSplit();
  await adoptRemoteSplit(remoteSplitFetch);

  const connectedProvider = params.get("status") === "connected" ? params.get("connector") : null;
  if (connectedProvider) markConnectorConnected(connectedProvider);
  const viewIntent = isView(wanted) && canView(wanted) && wanted !== "chats";

  const bareEntry = !viewIntent && !wantedSession && wanted !== "app-edit" && !connectedProvider;
  if (bareEntry && !restoredCanvasNeedsSessionList()) mountRestoredCanvas();

  const sessions = refreshSessions({ showLoading: true });

  if (wantedSession && !viewIntent && wanted !== "app-edit") {
    const transcript = entriesPrefetch ?? fetchTranscript(wantedSession, { tailTurns: TAIL_TURNS }).catch(() => null);
    const linked = (await transcript)?.session;
    if (linked) {
      exitSplitIfActive();
      if (!sessionsState.list.some((s) => s.id === linked.id)) sessionsState.list = [linked, ...sessionsState.list];
      revealSessionSurface(linked);
      await openSession(linked, transcript, approvalsPrefetch ?? undefined);
      return;
    }
    await sessions;
    const match = sessionsState.list.find((s) => s.id === wantedSession);
    if (match) {
      exitSplitIfActive();
      revealSessionSurface(match);
      await openSession(match);
    } else if (mountRestoredCanvas()) {
      canvasToast("That conversation wasn't found, or you don't have access to it.");
      syncUrlFromState();
    } else {
      showMainEmpty("That conversation wasn't found, or you don't have access to it.");
      renderList();
    }
    return;
  }

  await sessions;

  if (wanted === "app-edit") {
    const slug = (params.get("slug") ?? "").toLowerCase();
    if (/^[a-z0-9-]{1,63}$/.test(slug)) {
      openAppEditChat(slug);
      return;
    }
    showMainEmpty("This edit link is missing a valid app name.");
    return;
  }

  if (wanted === "keychain") {
    const provider = params.get("connector");
    const status = params.get("status");
    if (provider && status) noteConnectorResult(provider, status);
    switchView("keychain");
  } else if (viewIntent) {
    if (wanted === "contexts" || wanted === "files" || wanted === "deploys") {
      const scope =
        params.get("scope") ?? (wantedItem ? resolveProjectScope(await ensureContexts(), wantedItem) : null);
      if (scope) contextsState.selected = scope;
    }
    if (wanted === "crons" && wantedItem) openCronById(wantedItem);
    if (wanted === "webhooks" && wantedItem) openWebhookById(wantedItem);
    if (wanted === "inbox" && wantedItem) openInboxItemById(wantedItem);
    if (wanted === "skills" && wantedItem) openSkillById(wantedItem);
    switchView(wanted as View);
  } else if (connectedProvider && sessionsState.list.length) {
    const recent = [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a))[0]!;
    exitSplitIfActive();
    await openSession(recent);
  } else if (!mountRestoredCanvas() && !mainConversation().state.threadRef) {
    mainConversation().newChat();
  }
}
