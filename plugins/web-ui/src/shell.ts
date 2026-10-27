import { loadMessageTranscript, messageLinkSeq } from "./message-link.ts";
import { initializeBrowserErrors, stopBrowserErrors } from "./browser-errors";
import { initializeAnalytics, capturePageview, stopAnalytics } from "./product-analytics";
import { captureSlackReturn } from "./slack-account";
import { captureConnectionReturn } from "./connection-return";
import { renderModelConnectGate } from "./model-connect";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Box,
  Brain,
  CalendarDays,
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
  Rocket,
  Search,
  Settings,
  ShieldUser,
  Webhook,
  type IconNode,
} from "lucide";
import {
  ApiError,
  setSigninRequiredHandler,
  type SigninRequired,
  fetchRuntimeConfig,
  fetchSessionApprovals,
  fetchTranscript,
  TAIL_TURNS,
  webFetch,
  withBase,
  type CoreSession,
  type PendingApproval,
  type TranscriptPage,
  loadChatPrefs,
  fetchSessionRow,
} from "./core-bridge";
import { seedRuntimeConfig } from "./runtime-config-store";
import { swallow, swallowAs } from "../../chassis/src/errors";
import { brandMark, brandName } from "./ui";
import { icon } from "./icons";
import { trackVisualViewport } from "./viewport";
import { markConnectorConnected } from "./chat";
import { clearSkillsCache } from "./composer";
import { allConversations, ensureDeliveryStream, mainConversation, onExitCanvas } from "./conversations";
import { clearAllDrafts, newChatDraftKey, saveDraft } from "./drafts";
import { deepLinkPath, isPlainLeftClick, parseDeepLink, sessionLinkTarget, UI_BASE } from "./deep-link";
import {
  adoptRemoteSplit,
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
  singlePaneSessionId,
} from "./split";
import { activityOf } from "./session-list";
import { replaceChildrenPreservingFocus } from "./pane-focus";
import {
  openSession,
  refreshSessions,
  renderList,
  resetSessionsState,
  sessionTitle,
  sessionsState,
  revealSessionSurface,
  startNewChatInLastScope,
  startNewChat,
} from "./sessions";
import { sessionSelectionBar, menuOption } from "./session-actions";
import { renderChatsPage } from "./session-rows";
import { openCronById, renderCronsPage, routeCronsHistory } from "./crons";
import { openWebhookById, renderWebhooksPage, routeWebhooksHistory } from "./webhooks";
import { renderFiles } from "./files";
import { setScopedSession } from "./session-scope";
import { openChatSearch } from "./search";
import { closeBrowse, openBrowse } from "./browse";
import { hideTooltip, tip } from "./tooltip";
import { clearConnectorNotice, noteConnectorResult, renderConnectors, resetKeychainState } from "./connectors";
import { openDeployById, renderDeploys } from "./deploys";
import { renderMemory, resetMemoryState } from "./memory";
import { renderCalendar } from "./calendar";
import { renderInbox, resetActiveInboxItem, resetInboxState, routeInboxHistory } from "./inbox";
import { refreshInbox } from "./inbox-feed";
import { inboxOpenCount } from "./inbox-model";
import { openSkillById, renderSkills, routeSkillsHistory } from "./skills";
import { watchAppAnnotations } from "./app-annotations";
import { applyTheme, renderSettings, loadOpenNewChat, watchSystemTheme } from "./settings";
import { contextsState, ensureContexts, renderContexts, resetContextsState, resolveProjectScope } from "./contexts";
import { appState, can, canView, isView, type Me, type View } from "./shell-state";
import { UI_OUTDATED_EVENT } from "../../chassis/src/ui-release.ts";
import { activeSessionForDocumentTitle, updateDocumentTitle } from "./document-title";
import {
  AuthGate,
  clearPortalAttempt,
  deniedGate,
  gateFor,
  impersonationBanner,
  outdatedBanner,
  portalGate,
  showConversationError,
  unreachableGate,
} from "./shell-gates";
import {
  applySavedSidebarWidth,
  closeSidebarOnNarrowView,
  onSidebarKeydown,
  resetSidebarWidth,
  root,
  sidebarOpen,
  sidebarToggleLabel,
  startSidebarResize,
  syncSidebarAccessibility,
  toggleSidebar,
  updateSidebarToggleLabels,
} from "./shell-sidebar";
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

let shellMounted = false;
let pendingCanvasRestore: Promise<void> | null = null;

setSigninRequiredHandler((detail) => renderAuthGate(gateFor(detail.reason)));

onExitCanvas(() => exitSplitIfActive());

let uiOutdated = false;

window.addEventListener(UI_OUTDATED_EVENT, () => {
  if (uiOutdated) return;
  uiOutdated = true;
  if (root.querySelector(".layout")) mountShell();
});

export const ADMIN_HOME_URL = `${UI_BASE}/settings/history`;

export function syncUrlFromState(sessionOverride?: string | null): void {
  const chatState = mainConversation().state;
  const fromState =
    sessionOverride !== undefined ? sessionOverride : (chatState.sessionId ?? chatState.rememberedSessionId);
  const sessionId = splitState.active ? singlePaneSessionId() : fromState;
  let next = deepLinkPath(UI_BASE, appState.currentView, sessionId, contextsState.selected);
  const linked = parseDeepLink(UI_BASE, location.pathname, location.search);
  if (appState.currentView === "settings" && linked.view === "settings") return;
  const seq = messageLinkSeq(location.search);
  if (appState.currentView === "chats" && linked.session === sessionId && seq !== null) next += `?seq=${seq}`;
  if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
}
trackVisualViewport();

const ICON = {
  newChat: Plus,
  inbox: InboxGlyph,
  calendar: CalendarDays,
  chats: MessageSquare,
  contexts: Folder,
  files: Files,
  keychain: KeyRound,
  deploys: Rocket,
  webhooks: Webhook,
  crons: Clock,
  memory: Brain,
  skills: Box,
  home: House,
  browse: LayoutGrid,
};

export async function signOut(): Promise<void> {
  stopAnalytics();
  stopBrowserErrors();
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
  let endedSession: boolean;
  let redirectTo = "/";
  try {
    const r = await fetch("/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    endedSession = r.ok;
    if (r.ok) redirectTo = ((await r.json()) as { redirectTo?: string }).redirectTo ?? "/";
  } catch {
    endedSession = false;
  }
  if (!endedSession) {
    renderAuthGate({ kind: "portal" });
    return;
  }
  clearPortalAttempt();
  location.href = redirectTo;
}

export function renderAuthGate(gate: AuthGate): void {
  stopAnalytics();
  stopBrowserErrors();
  shellMounted = false;
  const gates = { portal: portalGate, denied: deniedGate, unreachable: unreachableGate };
  render(gates[gate.kind](), root);
}

export function mountShell(): void {
  applySavedSidebarWidth();
  const impersonatedBy = appState.me?.impersonatedBy ?? null;
  let banner: TemplateResult | typeof nothing = nothing;
  if (uiOutdated) banner = outdatedBanner();
  else if (impersonatedBy) banner = impersonationBanner(impersonatedBy);
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
    root,
  );
  appState.topEl = root.querySelector("#sidebar-top");
  appState.listEl = root.querySelector("#sidebar-body");
  appState.mainEl = root.querySelector("#main");
  footerEl = root.querySelector("#sidebar-footer");
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
          <span class="user-name">${appState.me?.displayName?.trim() || appState.me?.user || ""}</span>
        </button>
        ${
          userMenuOpen
            ? html`<div class="session-menu-popover user-menu-popover" role="menu">
                ${menuOption(LogOut, "Sign out", signOutFromMenu)}
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
        ${navRow("chats", ICON.home, "Home")}
        ${can("inbox") ? html`${inboxNavRow()} ${navRow("calendar", ICON.calendar, "Calendar")}` : nothing}
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
      ${sessionSelectionBar() ?? nothing}
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
  capturePageview(v);
  appState.viewRenderSeq++;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  if (v !== "chats") {
    mainConversation().teardown();
    mainConversation().composer.resetComposer();
  }
  renderSidebarTop();
  syncUrlFromState();
  if (v === "inbox") resetActiveInboxItem();
  if (v !== "chats") return void VIEW_RENDERERS[v]();
  const seq = appState.viewRenderSeq;
  const showChats = () => {
    if (appState.currentView !== "chats" || appState.viewRenderSeq !== seq) return;
    if (mountRestoredCanvas()) drawCanvas();
    else void renderChatsPage();
    renderList();
  };
  if (!pendingCanvasRestore) return showChats();
  appState.mainEl?.replaceChildren(
    Object.assign(document.createElement("div"), { className: "empty", textContent: "Loading conversations…" }),
  );
  void pendingCanvasRestore.then(showChats);
}

const VIEW_RENDERERS: Record<Exclude<View, "chats">, () => unknown> = {
  inbox: renderInbox,
  calendar: renderCalendar,
  contexts: renderContexts,
  webhooks: renderWebhooksPage,
  crons: renderCronsPage,
  files: renderFiles,
  keychain: renderConnectors,
  deploys: renderDeploys,
  memory: renderMemory,
  skills: renderSkills,
  settings: renderSettings,
};

function refreshActiveView(v: View): void {
  if (v === "inbox") resetActiveInboxItem();
  syncUrlFromState();
  if (v === "keychain") clearConnectorNotice();
  if (v !== "chats") void VIEW_RENDERERS[v]();
  else if (splitState.active) void refreshSessions({ silent: true, refreshContexts: true });
  else void renderChatsPage();
}

export function showMainEmpty(text: string): void {
  exitSplitIfActive();
  mainConversation().state.host = null;
  if (appState.mainEl)
    appState.mainEl.replaceChildren(
      Object.assign(document.createElement("div"), { className: "empty", textContent: text }),
    );
}

export function replacePanePreservingFocus(host: HTMLElement): void {
  if (!appState.mainEl) return;
  replaceChildrenPreservingFocus(appState.mainEl, host);
}

const HISTORY_ROUTES: Partial<Record<View, (item: string | null) => void>> = {
  crons: routeCronsHistory,
  webhooks: routeWebhooksHistory,
  skills: routeSkillsHistory,
  inbox: routeInboxHistory,
};

const OPEN_BY_ID: Partial<Record<View, (id: string) => void>> = {
  deploys: openDeployById,
  crons: openCronById,
  webhooks: openWebhookById,
  skills: openSkillById,
};

window.addEventListener("popstate", () => {
  const route = HISTORY_ROUTES[appState.currentView];
  const { view, item } = parseDeepLink(UI_BASE, location.pathname, location.search);
  if (route && view === appState.currentView) route(item);
});

window.addEventListener("focus", () => {
  if (!appState.me) return;
  if (appState.currentView === "contexts") void renderContexts();
  else if (appState.currentView === "chats") void refreshSessions({ silent: true, refreshContexts: true });
});

function warmDeferredChunks(): void {
  const warm = (): void =>
    void import("@earendil-works/pi-web-ui").catch(swallowAs("web-ui: warm chat chunk", undefined));
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(warm);
  else setTimeout(warm, 1500);
}

async function openAppEditChat(slug: string): Promise<void> {
  const user = appState.me?.user ?? "anon";
  const threadRef = `web:${user}:app-edit:${slug}`;
  const existing =
    sessionsState.list.find((s) => s.threadRef === threadRef) ??
    (await fetchSessionRow({ threadRef }).catch(swallowAs("web-ui: find app edit chat", null)));
  if (existing) {
    void openSession(existing);
    return;
  }
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

async function showLinkedSession(
  linked: CoreSession,
  transcript: Promise<TranscriptPage | null>,
  seq: number | null,
  approvals?: Promise<{ approvals: PendingApproval[] } | null>,
): Promise<void> {
  if (!sessionsState.list.some((s) => s.id === linked.id)) sessionsState.list = [linked, ...sessionsState.list];
  revealSessionSurface(linked);
  await openSession(linked, transcript, approvals);
  if (seq !== null)
    requestAnimationFrame(() => {
      for (const conversation of allConversations())
        if (conversation.state.sessionId === linked.id) conversation.revealEntry(seq);
    });
}

document.addEventListener("click", (e) => {
  if (!shellMounted || e.defaultPrevented || !isPlainLeftClick(e)) return;
  const anchor = e.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
  if (!anchor?.href || anchor.hasAttribute("download")) return;
  const target = sessionLinkTarget(anchor.href, location.origin, UI_BASE);
  if (!target) return;
  e.preventDefault();
  const open = allConversations().find(
    (conversation) => conversation.state.sessionId === target.session && conversation.state.host?.isConnected,
  );
  if (open) {
    if (target.seq !== null) open.revealEntry(target.seq);
    return;
  }
  const transcript = loadMessageTranscript(
    (window) => fetchTranscript(target.session, window),
    target.seq,
    TAIL_TURNS,
  ).catch(() => null);
  void (async () => {
    const linked = sessionsState.list.find((s) => s.id === target.session) ?? (await transcript)?.session;
    if (linked) await showLinkedSession(linked, transcript, target.seq);
    else location.assign(anchor.href);
  })();
});

async function openWantedView(wanted: View, wantedItem: string | null, params: URLSearchParams): Promise<void> {
  if (wanted === "keychain") {
    const provider = params.get("connector");
    const status = params.get("status");
    if (provider && status) noteConnectorResult(provider, status);
  }
  if (["contexts", "files", "deploys", "crons", "webhooks", "skills"].includes(wanted)) {
    const scope = params.get("scope") ?? (wantedItem ? resolveProjectScope(await ensureContexts(), wantedItem) : null);
    if (scope) contextsState.selected = scope;
  }
  if (wantedItem) OPEN_BY_ID[wanted]?.(wantedItem);
  switchView(wanted);
  if (wanted === "inbox") routeInboxHistory(wantedItem);
}

export async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.get("themeOnly") === "1") return;
  captureConnectionReturn(location.href);
  captureSlackReturn(location.href);
  const {
    view: wanted,
    session: wantedSession,
    item: wantedItem,
  } = parseDeepLink(UI_BASE, location.pathname, location.search);
  document.body.classList.toggle("app-edit-embed", wanted === "app-edit" && params.get("embed") === "1");
  const prefillRoute = wanted === null || wanted === "new";
  const prefill = prefillRoute && !wantedSession ? (params.get("q")?.slice(0, 20_000) ?? null) : null;
  const chatsLink = wanted === null || wanted === "chats";
  const linkedId = wantedSession && chatsLink ? wantedSession : null;
  let transcriptUnavailable = false;
  const wantedSeq = messageLinkSeq(location.search);
  const loadLinkedTranscript = (id: string) =>
    loadMessageTranscript((window) => fetchTranscript(id, window), wantedSeq, TAIL_TURNS).catch((error: unknown) => {
      transcriptUnavailable = !(error instanceof ApiError && (error.status === 404 || error.status === 403));
      return null;
    });
  const transcriptPrefetch = linkedId ? loadLinkedTranscript(linkedId) : null;
  const approvalsPrefetch = linkedId ? fetchSessionApprovals(linkedId) : null;
  const runtimeConfigFetch = fetchRuntimeConfig();
  const remoteSplitFetch = fetchRemoteSplit();
  const openNewChatFetch = loadOpenNewChat();
  void loadChatPrefs();

  let r: Response;
  try {
    r = await webFetch(withBase("/me"));
  } catch {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  if (r.status === 401) {
    const body = (await r.json().catch(() => ({}))) as SigninRequired;
    renderAuthGate(gateFor(body.reason));
    return;
  }
  if (!r.ok) {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  resetKeychainState();
  appState.me = (await r.json()) as Me;
  void initializeBrowserErrors(appState.me);
  void initializeAnalytics(appState.me, isView(wanted) && canView(wanted) ? wanted : "chats");
  clearPortalAttempt();
  if (appState.me.individualModelAuth && !appState.me.modelAuthConnected) {
    shellMounted = false;
    renderModelConnectGate();
    return;
  }
  const sessions = refreshSessions({ showLoading: true });
  const personalScope = `personal:${appState.me.user}`;
  const prefetchedConfig = await runtimeConfigFetch;
  const runtimeConfig =
    prefetchedConfig?.scopeId === personalScope ? prefetchedConfig : await fetchRuntimeConfig(personalScope);
  if (runtimeConfig) seedRuntimeConfig(personalScope, runtimeConfig);
  mountShell();
  renderList();
  shellMounted = true;
  ensureDeliveryStream();
  warmDeferredChunks();
  void refreshInbox({ silent: true });
  const connectedProvider = params.get("status") === "connected" ? params.get("connector") : null;
  if (connectedProvider) markConnectorConnected(connectedProvider);
  const viewIntent = isView(wanted) && canView(wanted) && wanted !== "chats";
  const restoreLast = viewIntent || !(await openNewChatFetch);
  if (restoreLast) loadPersistedSplit();
  if (restoreLast && !wantedSession && wanted !== "app-edit" && prefill === null) {
    const restore = adoptRemoteSplit(remoteSplitFetch).then(async () => {
      if (viewIntent && restoredCanvasNeedsSessionList()) await sessions;
    });
    pendingCanvasRestore = restore;
    void restore.then(() => {
      if (pendingCanvasRestore === restore) pendingCanvasRestore = null;
    });
    if (!viewIntent) await restore;
  }

  const bareEntry = !viewIntent && !wantedSession && wanted !== "app-edit" && !connectedProvider;
  if (restoreLast && bareEntry && !restoredCanvasNeedsSessionList()) mountRestoredCanvas(true);

  if (wantedSession && !viewIntent && wanted !== "app-edit") {
    const transcript = transcriptPrefetch ?? loadLinkedTranscript(wantedSession);
    const linked = (await transcript)?.session;
    if (linked) {
      exitSplitIfActive();
      await showLinkedSession(linked, transcript, wantedSeq, approvalsPrefetch ?? undefined);
      return;
    }
    await sessions;
    const match = sessionsState.list.find((s) => s.id === wantedSession);
    if (match) {
      exitSplitIfActive();
      revealSessionSurface(match);
      await openSession(match);
    } else {
      showConversationError(transcriptUnavailable);
    }
    return;
  }

  if (viewIntent) return openWantedView(wanted as View, wantedItem, params);

  await sessions;

  if (prefill !== null) {
    history.replaceState(null, "", deepLinkPath(UI_BASE, "chats", null));
    saveDraft(newChatDraftKey(appState.me.user), prefill);
    exitSplitIfActive();
    mainConversation().newChat();
    return;
  }

  if (wanted === "app-edit") {
    const slug = (params.get("slug") ?? "").toLowerCase();
    if (/^[a-z0-9-]{1,63}$/.test(slug)) {
      await openAppEditChat(slug);
      if (params.get("embed") === "1")
        watchAppAnnotations(slug, (text, files, id, remove) =>
          mainConversation().composer.addAnnotations(text, files, id, remove),
        );
      return;
    }
    showMainEmpty("This edit link is missing a valid app name.");
    return;
  }

  if (connectedProvider && sessionsState.list.length) {
    const recent = [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a))[0]!;
    exitSplitIfActive();
    await openSession(recent);
  } else if (!(restoreLast && mountRestoredCanvas()) && !mainConversation().state.threadRef) {
    mainConversation().newChat();
  }
}

window.addEventListener("qm:prepare-update", (event) => {
  (event as CustomEvent<{ ready: boolean }>).detail.ready = true;
});
