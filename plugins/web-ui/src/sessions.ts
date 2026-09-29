import {
  fetchNavigation,
  fetchSessionPage,
  fetchSessionReferences,
  resetNavigationTransport,
} from "./session-navigation.ts";
import type {
  SessionNavigationResult,
  SessionNavigationContext,
  SessionPageRequest,
  SessionPageResult,
  SessionReference,
  SessionNavigationSection,
} from "../../chassis/src/session-navigation.ts";
import {
  surfaceOf,
  channelLabel,
  defaultSessionTitle as formatDefaultSessionTitle,
  sessionTitle as formatSessionTitle,
  chatMatches as matchesSessionQuery,
} from "../../chassis/src/session-navigation.ts";
export { surfaceOf } from "../../chassis/src/session-navigation.ts";
import { sessionStatusMark } from "./session-status.ts";
import { openSessionShare } from "./session-share";
import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  Archive,
  Ban,
  Binoculars,
  Bot,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cog,
  CornerLeftUp,
  EllipsisVertical,
  Folder,
  Hash,
  Link,
  Lock,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  SquareTerminal,
  Users,
  X,
  type IconNode,
} from "lucide";
import {
  api,
  attachPendingApprovals,
  fetchSessionApprovals,
  fetchTranscript,
  currentEarlierCount,
  detachSession,
  inheritedTranscript,
  isContinuable,
  entriesToMessages,
  regenerateTitle,
  sharedContextLabel,
  slackThreadUrl,
  TAIL_TURNS,
  type TranscriptPage,
  updateSession,
  type PendingApproval,
  type CoreProject,
  type CoreSession,
} from "./core-bridge";
import { deepLinkPath, isPlainLeftClick, sessionLink, UI_BASE } from "./deep-link";
import {
  activityOf,
  chatBrowseStatusMatches,
  bumpActivity,
  sidebarSessions,
  groupProjectSessions,
  recencyGroup,
  recentProjectSeeds,
  reconcileSessions,
  rowIndicators,
  splitPinned,
  withPendingSession,
  withoutUnsentPending,
  type RecentItem,
  type ChatBrowseStatus,
} from "./session-list";
import { tip } from "./tooltip";
import { errMessage } from "../../chassis/src/errors";
import { copyText, icon, menuSelect, relTime, workingWave } from "./ui";
import { listPageTpl } from "./list-page";
import {
  contextsState,
  ensureContexts,
  openProjectDetail,
  personalScopeId,
  renameProject,
  scopeChip,
} from "./contexts";
import { groupDmLabel, groupDmText } from "./group-dm-label";
import { transcriptModel } from "./model-options";
import { appState, closeSidebarOnNarrowView, renderSidebarTop, syncDocumentTitle, syncUrlFromState } from "./shell";
import { allConversations, isLiveConversation, mainConversation } from "./conversations";
import type { Conversation } from "./conv-types";
import {
  startNewChatInCanvas,
  mountRestoredCanvas,
  focusedPaneConversation,
  openBackgroundInCanvas,
  beginSessionDrag,
  endPaneDrag,
  canvasToast,
  notifyPanesChanged,
  drawCanvas,
  closeSessionSurfaces,
  sessionInCanvas,
  splitInterceptsOpen,
  splitState,
} from "./split";
import { liveTurnThreadRef } from "./working-dot";
import { emptySelection, pruneSelection, selectionClick, type SessionSelection } from "./session-select";

export const sessionsState = {
  list: [] as CoreSession[],
  loaded: false,
  navigation: null as SessionNavigationResult<CoreSession> | null,
  openMenuId: null as string | null,
  renamingId: null as string | null,
  openingKey: null as string | null,
  webOnly: true,
  collapsedProjectScopes: new Set<string>(),
};

const navigationContexts = new Map<string, SessionNavigationContext>();
const groupPages = new Map<string, SessionPageResult<CoreSession>>();
const navigationRequests = new Map<string, AbortController>();
let navigationGeneration = 0;
let listAbort: AbortController | null = null;

export function rememberSessions(rows: CoreSession[]): void {
  const prior = new Map(sessionsState.list.map((row) => [row.id, row.subagents]));
  sessionsState.list = reconcileSessions(
    rows.map((row) =>
      row.subagents === undefined && prior.get(row.id) !== undefined ? { ...row, subagents: prior.get(row.id) } : row,
    ),
    sessionsState.list,
    sessionsState.list.map((row) => row.id),
  );
}

export function navigationContext(scopeId: string): SessionNavigationContext | undefined {
  return navigationContexts.get(scopeId);
}

function rememberContexts(rows: SessionNavigationContext[]): void {
  for (const context of rows) navigationContexts.set(context.scopeId, context);
}

function pageRows(rows: CoreSession[]): CoreSession[] {
  const entities = new Map(sessionsState.list.map((row) => [row.id, row]));
  return rows.flatMap((row) => {
    const current = entities.get(row.id);
    return current ? [current] : [];
  });
}

export async function readSessionPage(
  request: SessionPageRequest,
  signal?: AbortSignal,
): Promise<SessionPageResult<CoreSession> | null> {
  const generation = sessionPatchGeneration;
  const patchEpoch = sessionPatchEpoch;
  const result = await fetchSessionPage(request, signal);
  if (generation !== sessionPatchGeneration || patchEpoch !== sessionPatchEpoch || signal?.aborted)
    throw new DOMException("Navigation cancelled", "AbortError");
  if (result) {
    rememberSessions(result.items);
    rememberContexts(result.contexts);
    if (result.actionable) {
      const { parentSessionId, parentSubagents } = result.actionable;
      if (parentSubagents === null) sessionsState.list = sessionsState.list.filter((row) => row.id !== parentSessionId);
      else
        sessionsState.list = sessionsState.list.map((row) =>
          row.id === parentSessionId ? { ...row, subagents: parentSubagents } : row,
        );
    }
  }
  return result;
}

export async function readSessionWindow(
  request: SessionPageRequest,
  loadedRows = 50,
  signal?: AbortSignal,
): Promise<SessionPageResult<CoreSession> | null> {
  let result = await readSessionPage(request, signal);
  for (let page = 1; result?.nextCursor && page < Math.ceil(loadedRows / 50); page++) {
    const cursor = result.nextCursor;
    const next = await readSessionPage({ ...request, cursor }, signal);
    if (!next) throw new Error("Session navigation became unavailable");
    if (next.nextCursor === cursor) throw new Error("Session cursor did not advance");
    result = mergeSessionPages(result, next);
  }
  return result;
}

export function mergeSessionPages(
  previous: SessionPageResult<CoreSession>,
  next: SessionPageResult<CoreSession>,
): SessionPageResult<CoreSession> {
  if (next.actionable?.parentSubagents === null) return next;
  const items = [...new Map([...previous.items, ...next.items].map((row) => [row.id, row])).values()];
  const depths = next.actionable
    ? new Map(
        [previous, next].flatMap((page) =>
          page.items.map((row, index) => [row.id, page.actionable?.depths[index]] as const),
        ),
      )
    : null;
  return {
    ...next,
    items,
    contexts: [...new Map([...previous.contexts, ...next.contexts].map((row) => [row.scopeId, row])).values()],
    ...(next.actionable
      ? { actionable: { ...next.actionable, depths: items.map((row) => depths!.get(row.id)!) } }
      : {}),
  };
}

export async function resolveSessionTarget(target: string): Promise<CoreSession | null> {
  if (!target || target.length > 512) throw new Error("Session target is too long");
  const page = await readSessionPage({ title: target, children: true });
  if (page?.items[0]) return page.items[0];
  const byId = await resolveSessionReference({ kind: "id", value: target });
  return byId ?? (page === null ? (sessionsState.list.find((row) => row.title === target) ?? null) : null);
}

export async function resolveSessionReferences(references: SessionReference[]): Promise<(CoreSession | null)[]> {
  const generation = sessionPatchGeneration;
  const patchEpoch = sessionPatchEpoch;
  const result = await fetchSessionReferences(references);
  if (generation !== sessionPatchGeneration || patchEpoch !== sessionPatchEpoch)
    throw new DOMException("Navigation cancelled", "AbortError");
  if (!result) {
    const full = await api<{ sessions: CoreSession[] }>("/api/sessions");
    if (!Array.isArray(full.sessions)) throw new Error("Invalid session list response");
    if (generation !== sessionPatchGeneration || patchEpoch !== sessionPatchEpoch)
      throw new DOMException("Navigation cancelled", "AbortError");
    sessionsState.list = reconcileSessions(full.sessions, sessionsState.list, openConversationIds());
    return references.map(
      (ref) =>
        full.sessions.find((row) => (ref.kind === "id" ? row.id === ref.value : row.threadRef === ref.value)) ?? null,
    );
  }
  for (const row of result.references)
    if (row.session === null)
      sessionsState.list = sessionsState.list.filter(
        (session) =>
          !session.id ||
          (row.reference.kind === "id"
            ? session.id !== row.reference.value
            : session.threadRef !== row.reference.value),
      );
  rememberSessions(result.references.flatMap((row) => (row.session ? [row.session] : [])));
  renderList();
  return result.references.map((row) => row.session);
}

const referenceRequests = new Map<
  string,
  {
    reference: SessionReference;
    promise: Promise<CoreSession | null>;
    resolve: (session: CoreSession | null) => void;
    reject: (error: unknown) => void;
    sent: boolean;
  }
>();

export function resolveSessionReference(reference: SessionReference): Promise<CoreSession | null> {
  const key = JSON.stringify(reference);
  const existing = referenceRequests.get(key);
  if (existing) return existing.promise;
  const pending = Promise.withResolvers<CoreSession | null>();
  referenceRequests.set(key, { reference, ...pending, sent: false });
  queueMicrotask(() => {
    const batch = [...referenceRequests.entries()].filter(([, row]) => !row.sent).slice(0, 12);
    if (!batch.length) return;
    for (const [, row] of batch) row.sent = true;
    void resolveSessionReferences(batch.map(([, row]) => row.reference))
      .then(
        (rows) => batch.forEach(([, row], i) => row.resolve(rows[i] ?? null)),
        (error) => batch.forEach(([, row]) => row.reject(error)),
      )
      .finally(() => {
        for (const [key, row] of batch) if (referenceRequests.get(key) === row) referenceRequests.delete(key);
      });
  });
  return pending.promise;
}

export function latestSession(): CoreSession | null {
  return sessionsState.navigation
    ? sessionsState.navigation.startup.latest
    : ([...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a))[0] ?? null);
}

function navigationReferences(): SessionReference[] {
  const references = allConversations()
    .filter((conv) => !splitState.active || conv !== mainConversation())
    .flatMap((conv): SessionReference[] => {
      if (conv.state.sessionId) return [{ kind: "id", value: conv.state.sessionId }];
      if (conv.state.threadRef) return [{ kind: "thread", value: conv.state.threadRef }];
      return [];
    });
  return [...new Map(references.map((ref) => [JSON.stringify(ref), ref])).values()].slice(0, 12);
}

async function loadNavigationSection(section: SessionNavigationSection, append = true): Promise<void> {
  const current = sessionsState.navigation;
  if (!current || listAbort || navigationRequests.has(section)) return;
  const cursor = current[section]?.nextCursor;
  if (append && !cursor) return;
  const generation = navigationGeneration;
  const patchEpoch = sessionPatchEpoch;
  const controller = new AbortController();
  navigationRequests.set(section, controller);
  renderList();
  try {
    const result = await fetchNavigation(
      { surface: sessionsState.webOnly ? "web" : "all", section, ...(append && cursor ? { cursor } : {}) },
      controller.signal,
    );
    if (generation !== navigationGeneration || patchEpoch !== sessionPatchEpoch || controller.signal.aborted) return;
    if (!result) {
      await refreshSessions({ silent: true });
      return;
    }
    const page = result[section]!;
    if (append && page.nextCursor === cursor) throw new Error("Session cursor did not advance");
    const prior = append ? (current[section]?.items ?? []) : [];
    const items = [
      ...new Map([...prior, ...page.items].map((item) => ["id" in item ? item.id : item.scopeId, item])).values(),
    ];
    Object.assign(current, { [section]: { ...page, items } });
    if (section !== "groups") rememberSessions(page.items as CoreSession[]);
    rememberContexts(result.contexts);
    sessionsNotice = "";
  } catch (error) {
    if (generation === navigationGeneration && !controller.signal.aborted)
      sessionsNotice = errMessage(error, "Failed to load conversations.");
  } finally {
    if (navigationRequests.get(section) === controller) navigationRequests.delete(section);
    if (generation === navigationGeneration) renderList();
  }
}

async function loadGroupPage(scopeId: string): Promise<void> {
  const key = `group:${scopeId}`;
  if (listAbort || navigationRequests.has(key)) return;
  const prior = groupPages.get(scopeId);
  if (prior && !prior.nextCursor) return;
  const generation = navigationGeneration;
  const patchEpoch = sessionPatchEpoch;
  const controller = new AbortController();
  navigationRequests.set(key, controller);
  renderList();
  try {
    const page = await readSessionPage(
      {
        scopeId,
        archived: false,
        pinned: false,
        surface: sessionsState.webOnly ? "web" : "all",
        ...(prior?.nextCursor ? { cursor: prior.nextCursor } : {}),
      },
      controller.signal,
    );
    if (generation !== navigationGeneration || patchEpoch !== sessionPatchEpoch || controller.signal.aborted) return;
    if (!page) {
      await refreshSessions({ silent: true });
      return;
    }
    if (prior?.nextCursor && page.nextCursor === prior.nextCursor) throw new Error("Session cursor did not advance");
    groupPages.set(scopeId, {
      ...page,
      items: [...new Map([...(prior?.items ?? []), ...page.items].map((row) => [row.id, row])).values()],
    });
    sessionsNotice = "";
  } catch (error) {
    if (generation === navigationGeneration && !controller.signal.aborted)
      sessionsNotice = errMessage(error, "Failed to load conversations.");
  } finally {
    if (navigationRequests.get(key) === controller) navigationRequests.delete(key);
    if (generation === navigationGeneration) renderList();
  }
}

let selection: SessionSelection = emptySelection();
type SessionPatch = { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null };
const sessionPatchTails = new Map<string, Promise<void>>();
const sessionPatchVersions = new Map<string, number>();
let sessionPatchGeneration = 0;
let sessionPatchEpoch = 0;

export function clearSessionSelection(): boolean {
  if (!selection.ids.size && !selection.anchor) return false;
  selection = emptySelection();
  selectColorOpen = false;
  redrawSelection();
  return true;
}

export function hasSessionSelection(): boolean {
  return selection.ids.size > 0;
}

let selectColorOpen = false;

function redrawSelection(): void {
  renderList();
  renderSidebarTop();
}

function visibleRowOrder(): string[] {
  const el = appState.listEl;
  if (!el) return [];
  return [...el.querySelectorAll<HTMLElement>("[data-session-id]")]
    .filter((row) => !row.closest("[hidden]"))
    .map((n) => n.dataset.sessionId ?? "")
    .filter(Boolean);
}

const WEB_ONLY_KEY = "web-ui:web-only";
sessionsState.webOnly = ((): boolean => {
  try {
    return localStorage.getItem(WEB_ONLY_KEY) !== "0";
  } catch {
    return true;
  }
})();

let sessionsLoading = false;
let sessionsNotice = "";
let sessionRefreshSeq = 0;
let recentContextsRequest: Promise<void> | null = null;
const RECENT_CONTEXT_MAX_AGE_MS = 30_000;
let renameDraft = "";
const refreshingTitleIds = new Set<string>();
let showArchived = false;
const SESSION_BATCH_SIZE = 50;
let recentLimit = SESSION_BATCH_SIZE;
let archivedLimit = SESSION_BATCH_SIZE;
let chatsPageLimit = SESSION_BATCH_SIZE;

let chatsPageScope: string | null = null;
let chatsPageQuery = "";
let chatsPageStatus: ChatBrowseStatus = "active";
let chatsPageSurface: "all" | "web" | "slack" = "all";
let chatsPageHost: HTMLElement | null = null;
let chatsPage: SessionPageResult<CoreSession> | null = null;
let chatsPageKey = "";
let chatsPageNotice = "";
let chatsPageAbort: AbortController | null = null;
let chatsPageTimer: ReturnType<typeof setTimeout> | undefined;

export function cancelSessionPageRead(): void {
  chatsPageAbort?.abort();
  chatsPageAbort = null;
  clearTimeout(chatsPageTimer);
  chatsPageTimer = undefined;
  chatsPageKey = "";
}

function changeChatsFilter(debounce = false): void {
  cancelSessionPageRead();
  chatsPage = null;
  chatsPageNotice = "";
  chatsPageLimit = SESSION_BATCH_SIZE;
  if (debounce && sessionsState.navigation) {
    chatsPageTimer = setTimeout(() => {
      chatsPageTimer = undefined;
      drawChatsPage();
    }, 200);
  }
  drawChatsPage();
}

async function loadChatsPage(append = false): Promise<void> {
  if (chatsPageAbort || !sessionsState.navigation) return;
  const cursor = append ? chatsPage?.nextCursor : null;
  if (append && !cursor) return;
  const host = chatsPageHost;
  const key = chatsPageKey;
  const patchEpoch = sessionPatchEpoch;
  const controller = new AbortController();
  chatsPageAbort = controller;
  const current = () =>
    !controller.signal.aborted &&
    key === chatsPageKey &&
    appState.currentView === "chats" &&
    host === chatsPageHost &&
    chatsPageShowing();
  drawChatsPage();
  try {
    const result = await readSessionWindow(
      {
        surface: chatsPageSurface,
        status: chatsPageStatus,
        ...(chatsPageScope ? { scopeId: chatsPageScope } : {}),
        ...(chatsPageQuery ? { query: chatsPageQuery } : {}),
        ...(cursor ? { cursor } : {}),
      },
      append ? 50 : (chatsPage?.items.length ?? 50),
      controller.signal,
    );
    if (!current() || patchEpoch !== sessionPatchEpoch) return;
    if (!result) {
      await refreshSessions({ silent: true });
      return;
    }
    if (cursor && result.nextCursor === cursor) throw new Error("Session cursor did not advance");
    chatsPage = {
      ...result,
      items: [
        ...new Map([...(append ? (chatsPage?.items ?? []) : []), ...result.items].map((row) => [row.id, row])).values(),
      ],
    };
    chatsPageNotice = "";
  } catch (error) {
    if (current()) chatsPageNotice = errMessage(error, "Failed to load conversations.");
  } finally {
    if (chatsPageAbort === controller) chatsPageAbort = null;
    if (current()) drawChatsPage();
  }
}

export function resetSessionsState(): void {
  selection = emptySelection();
  selectColorOpen = false;
  sessionPatchGeneration++;
  sessionPatchEpoch++;
  for (const request of referenceRequests.values())
    request.reject(new DOMException("Navigation cancelled", "AbortError"));
  referenceRequests.clear();
  sessionPatchTails.clear();
  sessionPatchVersions.clear();
  sessionsState.list = [];
  sessionsState.loaded = false;
  sessionsState.navigation = null;
  navigationGeneration++;
  listAbort?.abort();
  for (const controller of navigationRequests.values()) controller.abort();
  navigationRequests.clear();
  groupPages.clear();
  navigationContexts.clear();
  resetNavigationTransport();
  listRequestedAt = 0;
  sessionsRefreshRunning = false;
  queuedSessionsRefresh = null;
  sessionRefreshSeq++;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  sessionsState.openingKey = null;
  sessionsState.collapsedProjectScopes.clear();
  renameDraft = "";
  refreshingTitleIds.clear();
  showArchived = false;
  recentLimit = SESSION_BATCH_SIZE;
  archivedLimit = SESSION_BATCH_SIZE;
  chatsPageLimit = SESSION_BATCH_SIZE;
  chatsPageScope = null;
  chatsPageQuery = "";
  chatsPageStatus = "active";
  chatsPageSurface = "all";
  chatsPageHost = null;
  cancelSessionPageRead();
  chatsPage = null;
  chatsPageNotice = "";
  recentContextsRequest = null;
}

function projectSeedsForRecents() {
  return recentProjectSeeds(contextsState.list);
}

function recentItemActivity(item: RecentItem): number {
  if (item.kind === "session") return activityOf(item.session);
  const group = sessionsState.navigation?.groups.items.find((group) => group.scopeId === item.scopeId);
  if (group) return group.lastActivityAt;
  if (item.sessions[0]) return activityOf(item.sessions[0]);
  const context = contextsState.list.find((candidate) => candidate.scopeId === item.scopeId);
  return context?.lastActivityAt ?? context?.project?.createdAt ?? context?.project?.updatedAt ?? 0;
}

function recentItemsFor(sessions: readonly CoreSession[]): RecentItem[] {
  return groupProjectSessions(sessions, projectSeedsForRecents()).sort(
    (a, b) => recentItemActivity(b) - recentItemActivity(a),
  );
}

function loadRecentContexts(force = false): void {
  const fresh = contextsState.loaded && Date.now() - contextsState.loadedAt < RECENT_CONTEXT_MAX_AGE_MS;
  if (appState.currentView !== "chats" || recentContextsRequest || (!force && fresh)) return;
  const request = ensureContexts(force || !fresh).then(() => {
    if (appState.currentView === "chats") renderList();
  });
  recentContextsRequest = request;
  void request.finally(() => {
    if (recentContextsRequest === request) recentContextsRequest = null;
  });
}

function listWhen(ms: number): string {
  if (Date.now() - ms < 6 * 86_400_000) return relTime(ms);
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function sessionSlackUrl(s: Pick<CoreSession, "threadRef">): string | null {
  return slackThreadUrl(appState.me?.slackWorkspaceUrl ?? null, s.threadRef);
}

function projectName(scopeId: string): string | null {
  return projectOf(scopeId)?.name ?? null;
}

function projectOf(scopeId: string): Pick<CoreProject, "id" | "name" | "ownerId"> | null {
  return (
    navigationContexts.get(scopeId)?.project ??
    contextsState.list.find((context) => context.scopeId === scopeId)?.project ??
    null
  );
}

function projectMenuKey(scopeId: string): string {
  return `project:${scopeId}`;
}

export function defaultSessionTitle(s: CoreSession): string {
  return formatDefaultSessionTitle(s, projectName(s.scopeId));
}

export function groupDmTitle(s: CoreSession): TemplateResult | string {
  if (s.title && s.title.trim()) return s.title;
  if (projectName(s.scopeId)) return defaultSessionTitle(s);
  if (s.type !== "group") return defaultSessionTitle(s);
  const label = groupDmLabel(s.channelName);
  if (!label) return defaultSessionTitle(s);
  return html`<span class="group-dm-title" ${tip(label.text)}>
    <span class="group-dm-count">${label.count}</span>
    <span class="group-dm-names">${label.text}</span>
  </span>`;
}

export function sessionTitle(s: CoreSession): string {
  return formatSessionTitle(s, projectName(s.scopeId));
}

export function slackLogo(size = 13): TemplateResult {
  return html`<svg
    class="slack-logo"
    width=${size}
    height=${size}
    viewBox="0 0 122.8 122.8"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
    />
    <path
      d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
    />
    <path
      d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
    />
    <path
      d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
    />
  </svg>`;
}

function visibleSessions(): CoreSession[] {
  const sorted = sidebarSessions(sessionsState.list).sort((a, b) => activityOf(b) - activityOf(a));
  return sessionsState.webOnly ? sorted.filter((s) => surfaceOf(s) === "web") : sorted;
}

export function renderList(): void {
  syncDocumentTitle();
  if (chatsPageShowing()) drawChatsPage();
  if (!appState.listEl) return;
  const navigation = sessionsState.navigation;
  const visible = visibleSessions();
  const active = visible.filter((s) => !s.archived);
  const archived = navigation
    ? pageRows(navigation.archived?.items ?? []).filter((s) => s.archived)
    : visible.filter((s) => s.archived);
  const pinned = navigation
    ? pageRows(navigation.pinned.items).filter((s) => s.pinned && !s.archived)
    : splitPinned(active).pinned;
  const rest = navigation
    ? pageRows(navigation.recent.items).filter((s) => !s.pinned && !s.archived)
    : splitPinned(active).rest;
  const keptIds = new Set([
    ...openConversationIds(),
    ...selection.ids,
    selection.anchor,
    sessionsState.openMenuId,
    sessionsState.renamingId,
  ]);
  const retained = visible.filter((session) => !session.id || keptIds.has(session.id));
  const loadedGroupRows = [...groupPages.values()].flatMap((page) => pageRows(page.items));
  const shownThreads = new Set(
    [
      ...rest.slice(0, navigation ? rest.length : recentLimit),
      ...archived.slice(0, navigation ? archived.length : archivedLimit),
      ...loadedGroupRows,
      ...retained,
    ].map((session) => session.threadRef),
  );
  let activeItems = recentItemsFor(rest);
  if (navigation) {
    const rows = [
      ...new Map(
        [...rest, ...loadedGroupRows, ...retained.filter((row) => !row.pinned && !row.archived)].map((row) => [
          row.threadRef,
          row,
        ]),
      ).values(),
    ];
    const groupedScopes = new Set(navigation.groups.items.map((group) => group.scopeId));
    activeItems = [
      ...navigation.groups.items.map((group): RecentItem => ({
        kind: "project",
        scopeId: group.scopeId,
        name: group.name,
        groupKind: group.kind,
        sessions: rows
          .filter((row) => row.scopeId === group.scopeId)
          .sort((a, b) => activityOf(b) - activityOf(a) || (a.id < b.id ? -1 : Number(a.id !== b.id))),
      })),
      ...rows
        .filter((row) => !groupedScopes.has(row.scopeId))
        .map((session): RecentItem => ({ kind: "session", session })),
    ].sort((a, b) => recentItemActivity(b) - recentItemActivity(a));
  }
  const reading = Boolean(listAbort && !listAbort.signal.aborted) || navigationRequests.size > 0;
  appState.listEl.setAttribute("aria-busy", String(reading));
  appState.listEl.dataset.sessionNavigationPending = [...navigationRequests.keys()].join(",");
  for (const section of ["recent", "pinned", "groups"] as const) {
    appState.listEl.dataset[`session${section[0]!.toUpperCase()}${section.slice(1)}Loaded`] = String(
      navigation?.[section].items.length ?? 0,
    );
    appState.listEl.dataset[`session${section[0]!.toUpperCase()}${section.slice(1)}Total`] = String(
      navigation?.[section].total ?? 0,
    );
  }
  let navigationState = sessionsState.loaded ? "ready" : "loading";
  if (sessionsNotice) navigationState = "error";
  if (reading || sessionsLoading) navigationState = "loading";
  appState.listEl.dataset.sessionNavigation = navigationState;
  appState.listEl.dataset.sessionNavigationMode = navigation ? "bounded" : "legacy";
  const archivedItems: RecentItem[] = archived.map((session) => ({
    kind: "session",
    session,
  }));
  armMidnightRefresh();
  render(
    html`
      ${detachDropZone()}
      ${
        pinned.length
          ? html`
              <div class="recents-group pinned-head">
                <span class="pinned-head-glyph">${icon(Pin, 11)}</span><span>Pinned</span>
              </div>
              <div class="pinned-children">
                ${repeat(
                  pinned,
                  (session) => session.threadRef,
                  (session) => sessionRow(session),
                )}
              </div>
            `
          : nothing
      }
      ${navigation?.pinned.nextCursor ? navigationMore("pinned", "Show more pinned conversations") : nothing}
      ${groupedRows(activeItems, shownThreads)}
      ${navigation?.groups.nextCursor ? navigationMore("groups", "Show more conversation groups") : nothing}
      ${navigation?.recent.nextCursor ? navigationMore("recent", "Show more conversations") : nothing}
      ${
        !navigation && rest.some((session) => !shownThreads.has(session.threadRef))
          ? html`<button
              class="archived-toggle"
              type="button"
              @click=${() => {
                recentLimit += SESSION_BATCH_SIZE;
                renderList();
              }}
            >
              Show more conversations
            </button>`
          : nothing
      }
      ${
        (navigation?.archivedCount ?? archived.length)
          ? html`
              <button
                class="archived-toggle ${showArchived ? "open" : ""}"
                ?disabled=${Boolean(listAbort)}
                @click=${toggleShowArchived}
              >
                ${icon(showArchived ? ChevronDown : ChevronRight, 14)}
                <span>Archived</span>
                <span class="archived-count">${navigation?.archivedCount ?? archived.length}</span>
              </button>
              ${
                showArchived
                  ? html`<div class="archived-children">
                      ${groupedRows(archivedItems, shownThreads)}
                      ${navigationRequests.has("archived") ? html`<div class="empty">Loading archived conversations…</div>` : nothing}
                      ${navigation?.archived?.nextCursor ? navigationMore("archived", "Show more archived conversations") : nothing}
                      ${
                        !navigation && archived.some((session) => !shownThreads.has(session.threadRef))
                          ? html`<button
                              class="archived-toggle"
                              type="button"
                              @click=${() => {
                                archivedLimit += SESSION_BATCH_SIZE;
                                renderList();
                              }}
                            >
                              Show more archived conversations
                            </button>`
                          : nothing
                      }
                    </div>`
                  : nothing
              }
            `
          : nothing
      }
      ${sessionsNotice ? html`<div class="empty" style="padding:16px" role="alert">${sessionsNotice}<button class="btn" @click=${() => void refreshSessions({ showLoading: true })}>Retry</button></div>` : ""}
      ${sessionsLoading ? html`<div class="empty" style="padding:16px">Loading conversations...</div>` : ""}
      ${
        !sessionsLoading &&
        !sessionsNotice &&
        (navigation
          ? navigation.recent.total + navigation.pinned.total + navigation.archivedCount === 0
          : visible.length === 0)
          ? html`<div class="empty" style="padding:16px">
              ${(navigation?.startup.hasSessions ?? sessionsState.list.length > 0) ? "Slack conversations hidden." : "No conversations yet."}
            </div>`
          : ""
      }
    `,
    appState.listEl,
  );
  const beforePrune = selection.ids.size;
  selection = pruneSelection(selection, new Set(visibleRowOrder()));
  if (selection.ids.size !== beforePrune) renderSidebarTop();
  if (sessionsState.openMenuId) {
    requestAnimationFrame(() => placeSessionMenu(appState.listEl?.querySelector(".session-menu-popover") ?? undefined));
  }
  notifyPanesChanged();
}

function navigationMore(section: SessionNavigationSection, label: string): TemplateResult {
  return html`<button
    class="archived-toggle"
    type="button"
    data-session-page=${section}
    ?disabled=${Boolean(listAbort) || navigationRequests.has(section)}
    @click=${() => void loadNavigationSection(section)}
  >
    ${navigationRequests.has(section) ? "Loading conversations…" : label}
  </button>`;
}

const NEW_CHAT_TOOLTIP = "Start a new chat";
const PROJECT_OPTIONS_TOOLTIP = "Project options";
const CHAT_OPTIONS_TOOLTIP = "Chat options";

function newChatHint(name: string): string {
  return `Start a new chat in ${name}`;
}

function recentItem(item: RecentItem, shownThreads: ReadonlySet<string>): TemplateResult {
  if (item.kind === "session") return sessionRow(item.session);
  const collapsed = sessionsState.collapsedProjectScopes.has(item.scopeId);
  const group = sessionsState.navigation?.groups.items.find((group) => group.scopeId === item.scopeId);
  const loadedPage = groupPages.get(item.scopeId);
  const hasMore =
    group && (loadedPage ? Boolean(loadedPage.nextCursor) : group.count > item.sessions.filter((row) => row.id).length);
  let glyph: IconNode | null = Folder;
  if (item.groupKind === "personal") glyph = null;
  else if (item.groupKind === "channel") glyph = Hash;
  else if (item.groupKind === "group") glyph = Users;
  let fallbackName = "Project";
  if (item.groupKind === "channel") fallbackName = "Channel";
  else if (item.groupKind === "group") fallbackName = "Group DM";
  const name = item.name ?? fallbackName;
  const childrenId = `recent-${item.scopeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const menuKey = projectMenuKey(item.scopeId);
  const menuOpen = sessionsState.openMenuId === menuKey;
  return html`
    <section
      class="recent-project ${item.sessions.some(isActiveRow) ? "active" : ""}"
      data-scope-id=${item.scopeId}
      aria-label=${`${name} project`}
    >
      ${
        sessionsState.renamingId === menuKey
          ? projectRenameRow(item)
          : html`<div class="recent-project-head">
              <button
                class="recent-project-toggle"
                type="button"
                aria-expanded=${collapsed ? "false" : "true"}
                aria-controls=${childrenId}
                @click=${() => toggleRecentProject(item.scopeId)}
              >
                <span class="recent-project-glyph">
                  ${glyph && !collapsed ? html`<span class="glyph">${icon(glyph, 14)}</span>` : nothing}
                  <span class="chev">${icon(collapsed ? ChevronRight : ChevronDown, 13)}</span>
                </span>
                <span class="recent-project-name" dir="auto">${name.replace(/^#/, "")}</span>
              </button>
              <div class="session-menu recent-project-menu ${menuOpen ? "menu-open" : ""}">
                <span class="recent-project-count">${group?.count ?? item.sessions.length}</span>
                <button
                  class="session-menu-btn"
                  data-menu-id=${menuKey}
                  type="button"
                  aria-label=${`Options for ${name}`}
                  aria-haspopup="menu"
                  aria-expanded=${menuOpen ? "true" : "false"}
                  ${tip(PROJECT_OPTIONS_TOOLTIP)}
                  @click=${(e: Event) => toggleSessionMenu(e, menuKey)}
                >
                  ${icon(EllipsisVertical, 15)}
                </button>
                ${menuOpen ? projectMenuPopover(item) : nothing}
              </div>
              <button
                class="recent-project-new-chat"
                type="button"
                aria-label=${newChatHint(name)}
                ${tip(NEW_CHAT_TOOLTIP)}
                @click=${(event: Event) => startProjectChat(event, item.scopeId, item.name)}
              >
                ${icon(Plus, 15)}
              </button>
            </div>`
      }
      <div class="recent-project-children" id=${childrenId} ?hidden=${collapsed}>
        ${!collapsed && hasMore ? html`<button class="archived-toggle" type="button" data-session-page="group" data-scope-id=${item.scopeId} ?disabled=${Boolean(listAbort) || navigationRequests.has(`group:${item.scopeId}`)} @click=${() => void loadGroupPage(item.scopeId)}>${navigationRequests.has(`group:${item.scopeId}`) ? "Loading conversations…" : `Show more in ${name}`}</button>` : nothing}
        ${
          collapsed
            ? nothing
            : repeat(
                item.sessions.filter((session) => shownThreads.has(session.threadRef)),
                (session) => session.threadRef,
                (session) => sessionRow(session, true),
              )
        }
      </div>
    </section>
  `;
}

function toggleRecentProject(scopeId: string): void {
  if (sessionsState.collapsedProjectScopes.has(scopeId)) sessionsState.collapsedProjectScopes.delete(scopeId);
  else sessionsState.collapsedProjectScopes.add(scopeId);
  renderList();
}

export function startNewChat(
  scopeId: string | null = null,
  name: string | null = null,
  threadRef?: string,
): Conversation | null {
  closeSidebarOnNarrowView();
  if (scopeId) sessionsState.collapsedProjectScopes.delete(scopeId);
  const pane = startNewChatInCanvas(scopeId ?? undefined, threadRef);
  if (pane) return pane;
  const conv = mainConversation();
  if (threadRef) conv.mountContinuable(threadRef, null, scopeId, [], name);
  else addPendingSession(conv.newChat(scopeId ? { scopeId, name } : undefined), scopeId, name);
  return conv;
}

export function startNewChatInLastScope(): void {
  const mounted = (focusedPaneConversation() ?? mainConversation()).state;
  const scopeId = mounted.scopeId ?? visibleSessions().find((s) => !s.archived)?.scopeId ?? null;
  startNewChat(scopeId, scopeId ? projectName(scopeId) : null);
}

function startProjectChat(event: Event, scopeId: string, name: string | null): void {
  event.stopPropagation();
  startNewChat(scopeId, name);
}

function projectMenuPopover(item: Extract<RecentItem, { kind: "project" }>): TemplateResult {
  const owned = projectOf(item.scopeId)?.ownerId === appState.me?.user;
  return html`
    <div class="session-menu-popover" role="menu" ${ref(placeSessionMenu)} @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="session-menu-option"
        type="button"
        role="menuitem"
        @click=${() => openProjectFromMenu(item.scopeId)}
      >
        ${icon(Folder, 15)}<span>View project</span>
      </button>
      ${
        owned
          ? html`<button
              class="session-menu-option"
              type="button"
              role="menuitem"
              @click=${() => beginRename(projectMenuKey(item.scopeId), item.name ?? "")}
            >
              ${icon(Pencil, 15)}<span>Rename</span>
            </button>`
          : nothing
      }
    </div>
  `;
}

function openProjectFromMenu(scopeId: string): void {
  sessionsState.openMenuId = null;
  openProjectDetail(scopeId);
}

function projectRenameRow(item: Extract<RecentItem, { kind: "project" }>): TemplateResult {
  const menuKey = projectMenuKey(item.scopeId);
  return html`<div class="recent-project-head renaming">
    ${renameInput(menuKey, "Rename project", () => commitProjectRename(item))}
  </div>`;
}

async function commitProjectRename(item: Extract<RecentItem, { kind: "project" }>): Promise<void> {
  if (sessionsState.renamingId !== projectMenuKey(item.scopeId)) return;
  const next = renameDraft.trim();
  sessionsState.renamingId = null;
  renameDraft = "";
  renderList();
  const project = projectOf(item.scopeId);
  if (!project || !next || next === project.name) return;
  await renameProject(project, next);
  await refreshSessions({ silent: true, refreshContexts: true });
  renderList();
}

export async function renderChatsPage(): Promise<void> {
  if (appState.currentView !== "chats") return;
  const refresh = refreshSessions({
    showLoading: sessionsState.list.length === 0,
    silent: sessionsState.list.length > 0,
  });
  await ensureContexts();
  drawChatsPage();
  await refresh;
  if (appState.currentView === "chats") drawChatsPage();
}

function chatsPageShowing(): boolean {
  return Boolean(chatsPageHost && appState.mainEl && chatsPageHost.parentElement === appState.mainEl);
}

export function drawChatsPage(): void {
  if (appState.currentView !== "chats" || !appState.mainEl || splitState.active) return;
  mainConversation().state.host = null;
  if (!chatsPageHost || chatsPageHost.parentElement !== appState.mainEl) {
    chatsPageHost = document.createElement("div");
    chatsPageHost.className = "pane chats-page";
    appState.mainEl.replaceChildren(chatsPageHost);
  }
  const navigation = sessionsState.navigation;
  const key = JSON.stringify([navigationGeneration, chatsPageScope, chatsPageQuery, chatsPageStatus, chatsPageSurface]);
  if (navigation && chatsPageKey !== key && !chatsPageTimer) {
    cancelSessionPageRead();
    chatsPageKey = key;
    chatsPageNotice = "";
    void loadChatsPage();
  }
  chatsPageHost.dataset.sessionPage = "chats";
  let pageState = navigation && !chatsPage ? "loading" : "ready";
  if (chatsPageNotice || sessionsNotice) pageState = "error";
  if (!sessionsState.loaded || chatsPageAbort || chatsPageTimer) pageState = "loading";
  chatsPageHost.dataset.sessionPageState = pageState;
  const q = chatsPageQuery.trim().toLowerCase();
  const matches = navigation
    ? pageRows(chatsPage?.items ?? [])
    : sidebarSessions(sessionsState.list)
        .filter((s) => chatBrowseStatusMatches(s, chatsPageStatus))
        .filter((s) => chatsPageSurface === "all" || surfaceOf(s) === chatsPageSurface)
        .filter((s) => (chatsPageScope ? s.scopeId === chatsPageScope : true))
        .filter((s) => !q || chatMatches(s, q))
        .sort((a, b) => activityOf(b) - activityOf(a));
  const rows = matches.slice(0, navigation ? matches.length : chatsPageLimit).map((s) => chatPageRow(s));
  if (navigation ? chatsPage?.nextCursor : matches.length > chatsPageLimit)
    rows.push(
      html`<div class="list-footer">
        <button
          class="btn"
          type="button"
          data-session-page="chats"
          ?disabled=${Boolean(chatsPageAbort)}
          @click=${() => {
            if (navigation) void loadChatsPage(true);
            else {
              chatsPageLimit += SESSION_BATCH_SIZE;
              drawChatsPage();
            }
          }}
        >
          Show more conversations
        </button>
      </div>`,
    );
  let empty = "No conversations yet. Start a new chat.";
  if (sessionsLoading && sessionsState.list.length === 0) empty = "Loading conversations…";
  else if (chatsPageScope || q || chatsPageStatus !== "active" || chatsPageSurface !== "all") {
    empty = "No conversations match.";
  }
  if (chatsPageAbort || chatsPageTimer) rows.push(html`<div class="empty">Loading conversations…</div>`);
  if (chatsPageNotice || sessionsNotice)
    rows.push(
      html`<div class="empty" role="alert">
        ${chatsPageNotice || sessionsNotice}<button
          class="btn"
          @click=${() => {
            if (navigation) changeChatsFilter();
            else void refreshSessions({ showLoading: true });
          }}
        >
          Retry
        </button>
      </div>`,
    );
  render(
    listPageTpl({
      title: "Chats",
      scope: chatsPageScope,
      onScope: (s) => {
        chatsPageScope = s;
        changeChatsFilter();
      },
      action: { label: "New chat", onClick: () => startNewChat() },
      search: {
        value: chatsPageQuery,
        placeholder: "Search chats…",
        onInput: (v) => {
          chatsPageQuery = v;
          changeChatsFilter(true);
        },
      },
      filters: html`${navigation && chatsPage ? html`<span data-session-page-total=${chatsPage.total}>${chatsPage.total} conversations</span>` : nothing}
        <div class="chat-filters">
          <div class="resource-tabs" role="tablist" aria-label="Conversation status">
            ${(
              [
                ["active", "Active"],
                ["waiting", "Waiting"],
                ["archived", "Archived"],
              ] as const
            ).map(
              ([value, label]) =>
                html`<button
                  role="tab"
                  type="button"
                  aria-selected=${chatsPageStatus === value}
                  class=${chatsPageStatus === value ? "active" : ""}
                  @click=${() => {
                    chatsPageStatus = value;
                    changeChatsFilter();
                  }}
                >
                  ${label}<span
                    >${navigation ? (chatsPage?.statusTotals ?? navigation.statusTotals)[value] : sidebarSessions(sessionsState.list).filter((session) => chatBrowseStatusMatches(session, value)).length}</span
                  >
                </button>`,
            )}
          </div>
          <div class="list-select">
            ${menuSelect({
              value: chatsPageSurface,
              ariaLabel: "Filter by surface",
              onSelect: (value) => {
                chatsPageSurface = (value ?? "all") as typeof chatsPageSurface;
                changeChatsFilter();
              },
              options: [
                { value: "all", label: "All surfaces" },
                { value: "web", label: "Web" },
                { value: "slack", label: "Slack" },
              ],
            })}
          </div>
        </div>`,
      rows,
      empty,
    }),
    chatsPageHost,
  );
}

function chatMatches(s: CoreSession, q: string): boolean {
  return matchesSessionQuery(s, q, projectName(s.scopeId));
}

export const syncWorkingPulse = (el?: Element): void => {
  if (!(el instanceof Element)) return;
  const running = (): Animation[] => el.getAnimations({ subtree: true });
  const pin = (): void => {
    for (const a of running()) a.startTime = 0;
  };
  if (running().length > 0) pin();
  else requestAnimationFrame(pin);
};

function liveThreads(): ReadonlySet<string> {
  const live = new Set<string>();
  for (const conv of allConversations()) {
    const ref = liveTurnThreadRef({
      mountedThreadRef: conv.state.threadRef,
      isStreaming: Boolean(conv.state.agent?.state.isStreaming),
      pendingSend: conv.state.pendingSend,
    });
    if (ref) live.add(ref);
  }
  return live;
}

function sessionWorking(s: CoreSession): boolean {
  return rowIndicators(s, liveThreads()).working;
}

function statusMarks(s: CoreSession): TemplateResult {
  const ind = rowIndicators(s, liveThreads(), sessionsState.list);
  return html`${ind.working ? html`<span class="working-mark" ${ref(syncWorkingPulse)}>${workingWave()}</span>` : nothing}${
    ind.awaiting ? html`<span class="awaiting-dot" aria-label="Waiting for your reply"></span>` : nothing
  }${
    ind.background
      ? html`<span
          class="bg-chip"
          role="button"
          tabindex="0"
          aria-label="${ind.background.label}. Click to inspect"
          ${tip(`${ind.background.label}. Click to inspect`)}
          @click=${(e: Event) => openBackgroundInspector(e, s)}
          @keydown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && openBackgroundInspector(e, s)}
          >${ind.background.jobs > 0 ? icon(Cog, 11) : nothing}${
            ind.background.watches > 0 ? icon(Binoculars, 11) : nothing
          }${ind.background.crons > 0 ? icon(Clock3, 11) : nothing}${ind.background.subagents > 0 ? icon(Bot, 11) : nothing}</span
        >`
      : nothing
  }`;
}

function openBackgroundInspector(e: Event, s: CoreSession): void {
  e.stopPropagation();
  e.preventDefault();
  if (openBackgroundInCanvas(s)) return;
  mainConversation().requestBackgroundPanel(s.id || null, s.threadRef);
  void openSession(s);
}

function isActiveRow(s: CoreSession): boolean {
  if (splitState.active) return Boolean(s.id) && sessionInCanvas(s.id);
  if (sessionsState.openingKey) return Boolean(s.id) && s.id === sessionsState.openingKey;
  const main = mainConversation().state;
  return Boolean((main.sessionId && s.id === main.sessionId) || (main.threadRef && s.threadRef === main.threadRef));
}

function chatPageRow(s: CoreSession): TemplateResult {
  const readOnly = !isContinuable(s, appState.me?.user ?? "");
  const color = displaySessionColor(s.color);
  return html`
    <div class="list-row chat-row ${color ? "colored" : ""}" style=${color ? `--session-color:${color}` : nothing}>
      <a
        class="chat-row-open"
        href=${deepLinkPath(UI_BASE, "chats", s.id)}
        @click=${(e: MouseEvent) => {
          if (!isPlainLeftClick(e)) return;
          e.preventDefault();
          void openSession(s);
        }}
      >
        <span class="list-row-title">${statusMarks(s)}<span dir="auto">${groupDmTitle(s)}</span></span>
        <span class="list-row-meta">
          ${sessionStatusMark(s.status)} ${scopeChip(s.scopeId, s.channelName ?? null)}
          ${surfaceOf(s) === "slack" ? html`<span class="surface surface-slack">${slackLogo(13)}</span>` : nothing}
          ${readOnly ? html`<span class="ro-lock" ${tip("Read-only")}>${icon(Lock, 12)}</span>` : nothing}
          <span class="list-row-date">${listWhen(activityOf(s))}</span>
          <span class="chat-row-arrow" aria-hidden="true">${icon(ChevronRight, 16)}</span>
        </span>
      </a>
      ${
        s.id
          ? html`<span class="chat-row-actions">
              <button
                class="icon-btn"
                type="button"
                ${tip(s.pinned ? "Unpin" : "Pin")}
                aria-label=${`${s.pinned ? "Unpin" : "Pin"} ${sessionTitle(s)}`}
                @click=${() => {
                  setPinned(s, !s.pinned);
                  drawChatsPage();
                }}
              >
                ${s.pinned ? icon(PinOff, 13.5) : icon(Pin, 13.5)}
              </button>
              <button
                class="icon-btn"
                type="button"
                ${tip("Share conversation")}
                aria-label=${`Share ${sessionTitle(s)}`}
                @click=${() => void openSessionShare(s.id)}
              >
                ${icon(Link, 13.5)}
              </button>
              <button
                class="icon-btn"
                type="button"
                ${tip(s.archived ? "Unarchive" : "Archive")}
                aria-label=${`${s.archived ? "Unarchive" : "Archive"} ${sessionTitle(s)}`}
                @click=${() => {
                  setArchived(s, !s.archived);
                  drawChatsPage();
                }}
              >
                ${s.archived ? icon(ArchiveRestore, 13.5) : icon(Archive, 13.5)}
              </button>
            </span>`
          : nothing
      }
    </div>
  `;
}

export function addPendingSession(threadRef: string, scopeId: string | null, channelName: string | null): void {
  const scope = scopeId ?? personalScopeId();
  let type: CoreSession["type"] = "dm";
  if (scope?.startsWith("group:")) type = "group";
  else if (scope?.startsWith("channel:")) type = "channel";
  const pending: CoreSession = {
    id: "",
    type,
    scopeId: scope ?? "",
    threadRef,
    createdAt: Date.now(),
    title: null,
    channelName,
    archived: false,
  };
  sessionsState.list = withPendingSession(sessionsState.list, pending);
  renderList();
}

export function dropPendingSession(threadRef: string): void {
  sessionsState.list = withoutUnsentPending(sessionsState.list, threadRef);
  renderList();
}

export function bumpSessionActivity(threadRef: string): void {
  sessionsState.list = bumpActivity(sessionsState.list, threadRef, Date.now());
  renderList();
}

function groupedRows(list: RecentItem[], shownThreads: ReadonlySet<string>): TemplateResult {
  const now = Date.now();
  const items: { key: string; tpl: TemplateResult }[] = [];
  let group: string | null = null;
  for (const item of list) {
    const key = item.kind === "session" ? item.session.threadRef : projectMenuKey(item.scopeId);
    if (
      item.kind === "session"
        ? !shownThreads.has(item.session.threadRef)
        : item.sessions.length > 0 &&
          sessionsState.openMenuId !== key &&
          sessionsState.renamingId !== key &&
          !item.sessions.some((session) => shownThreads.has(session.threadRef))
    )
      continue;
    const dateless = item.kind === "project" && item.sessions.length === 0;
    const g = recencyGroup(recentItemActivity(item), now);
    if (!dateless && g !== group) {
      group = g;
      items.push({ key: `group:${g}`, tpl: html`<div class="recents-group">${g}</div>` });
    }
    items.push({ key, tpl: recentItem(item, shownThreads) });
  }
  return html`${repeat(
    items,
    (it) => it.key,
    (it) => it.tpl,
  )}`;
}

let midnightTimer: number | undefined;
function armMidnightRefresh(): void {
  if (midnightTimer !== undefined) window.clearTimeout(midnightTimer);
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  midnightTimer = window.setTimeout(
    () => {
      midnightTimer = undefined;
      renderList();
    },
    Math.max(1_000, next - Date.now()),
  );
}

function surfaceGlyph(s: CoreSession): TemplateResult | typeof nothing {
  const surface = surfaceOf(s);
  if (surface === "slack") return html`<span class="surface-glyph">${slackLogo(12)}</span>`;
  if (surface === "core") return html`<span class="surface-glyph">${icon(SquareTerminal, 12)}</span>`;
  return nothing;
}

function rowContext(s: CoreSession): string | null {
  let label = sharedContextLabel(s.scopeId, s.channelName ?? null);
  if (surfaceOf(s) === "slack") label = s.type === "group" ? groupDmText(s.channelName) : channelLabel(s);
  return label && label !== sessionTitle(s) ? label : null;
}

function sessionRow(s: CoreSession, projectChild = false): TemplateResult {
  const saved = Boolean(s.id);
  if (saved && sessionsState.renamingId === s.id) return renameRow(s);
  const active = isActiveRow(s);
  const menuOpen = saved && sessionsState.openMenuId === s.id;
  const refreshingTitle = saved && refreshingTitleIds.has(s.id);
  const untitledProjectChild = projectChild && !s.title?.trim();
  let title = sessionTitle(s);
  if (untitledProjectChild) title = surfaceOf(s) === "web" ? "Web chat" : "New chat";
  const readOnly = !isContinuable(s, appState.me?.user ?? "");
  const surface = surfaceOf(s);
  const context = projectChild ? null : rowContext(s);
  const working = sessionWorking(s);
  const color = displaySessionColor(s.color);
  let titleContent: string | TemplateResult = groupDmTitle(s);
  if (refreshingTitle) {
    titleContent = html`<span class="sheen-label title-sheen thinking-sheen" data-sheen=${title}>${title}</span>`;
  } else if (untitledProjectChild) {
    titleContent = title;
  }
  const ariaLabel = [
    title,
    surface !== "web" ? surface : null,
    context,
    working ? "agent is working" : null,
    s.awaitingInput ? "waiting for your reply" : null,
    readOnly ? "read-only" : null,
    s.pinned ? "pinned" : null,
    selection.ids.has(s.id) ? "selected" : null,
    relTime(activityOf(s)),
  ]
    .filter(Boolean)
    .join(", ");
  return html`
    <div
      data-session-id=${saved ? s.id : nothing}
      class="session-row ${active ? "active" : ""} ${saved && selection.ids.has(s.id) ? "selected" : ""} ${menuOpen ? "menu-open" : ""} ${readOnly ? "read-only" : ""} ${refreshingTitle ? "title-refreshing" : ""} ${working ? "working" : ""} ${s.awaitingInput ? "awaiting-input" : ""} ${projectChild ? "project-child" : ""} ${color ? "colored" : ""}"
      style=${color ? `--session-color:${color}` : nothing}
    >
      <a
        class="session"
        href=${saved ? deepLinkPath(UI_BASE, "chats", s.id) : nothing}
        aria-busy=${refreshingTitle ? "true" : "false"}
        aria-label=${ariaLabel}
        aria-keyshortcuts="Space Shift+Space Control+Space Meta+Space"
        draggable=${saved ? "true" : "false"}
        @dragstart=${(e: DragEvent) => onSessionDragStart(e, s)}
        @dragend=${() => endSessionDrag()}
        @mousedown=${(e: MouseEvent) => {
          if (saved && e.shiftKey) e.preventDefault();
        }}
        @click=${(e: MouseEvent) => {
          if (saved && e.button === 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            selection = selectionClick(selection, visibleRowOrder(), s.id, {
              shift: e.shiftKey,
              toggle: e.metaKey || e.ctrlKey,
            });
            redrawSelection();
            return;
          }
          if (saved && !isPlainLeftClick(e)) return;
          e.preventDefault();
          const hadSelection = selection.ids.size > 0;
          selection = { ids: new Set(), anchor: saved ? s.id : null, shiftRange: new Set() };
          selectColorOpen = false;
          if (hadSelection) redrawSelection();
          void openSession(s);
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (!saved || e.key !== " ") return;
          e.preventDefault();
          selection = selectionClick(selection, visibleRowOrder(), s.id, {
            shift: e.shiftKey,
            toggle: !e.shiftKey || e.metaKey || e.ctrlKey,
          });
          redrawSelection();
        }}
        @dblclick=${(e: Event) => {
          if (!saved) return;
          e.preventDefault();
          startRename(s);
        }}
      >
        <div class="title" aria-live="polite">
          ${statusMarks(s)}${surfaceGlyph(s)}${readOnly ? html`<span class="ro-lock" ${tip("Read-only")}>${icon(Lock, 12)}</span>` : nothing}<span
            class="tl"
            dir="auto"
            >${titleContent}</span
          >${context ? html`<span class="row-context" ${tip(context)}>${context}</span>` : nothing}
        </div>
      </a>
      ${
        saved
          ? html`<div class="session-menu">
              <button
                class="session-menu-btn session-share-btn"
                type="button"
                ${tip("Share conversation")}
                aria-label=${`Share ${sessionTitle(s)}`}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  void openSessionShare(s.id);
                }}
              >
                ${icon(Link, 13.5)}
              </button>
              <button
                class="session-menu-btn session-archive-btn"
                type="button"
                ${tip(s.archived ? "Unarchive" : "Archive")}
                aria-label=${`${s.archived ? "Unarchive" : "Archive"} ${sessionTitle(s)}`}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  setArchived(s, !s.archived);
                }}
              >
                ${s.archived ? icon(ArchiveRestore, 13.5) : icon(Archive, 13.5)}
              </button>
              <button
                class="session-menu-btn"
                data-menu-id=${s.id}
                type="button"
                ${tip(CHAT_OPTIONS_TOOLTIP)}
                aria-label=${`Options for ${sessionTitle(s)}`}
                aria-haspopup="menu"
                aria-expanded=${menuOpen ? "true" : "false"}
                @click=${(e: Event) => toggleSessionMenu(e, s.id)}
              >
                ${icon(EllipsisVertical, 15)}
              </button>
              ${sessionStatusMark(s.status)} ${menuOpen ? sessionMenuPopover(s) : nothing}
            </div>`
          : nothing
      }
    </div>
  `;
}

let draggingChildId: string | null = null;

export function onSessionDragStart(e: DragEvent, s: CoreSession): void {
  if (!s.id) {
    e.preventDefault();
    return;
  }
  e.dataTransfer?.setData("application/x-webui-session", s.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  draggingChildId = s.parentSessionId ? s.id : null;
  appState.listEl?.classList.toggle("detach-drop-target", Boolean(draggingChildId));
  if (!draggingChildId) beginSessionDrag(s);
}

export function endSessionDrag(): void {
  draggingChildId = null;
  appState.listEl?.classList.remove("detach-drop-target");
  appState.listEl?.querySelector(".detach-drop-zone")?.classList.remove("over");
  endPaneDrag();
}

async function promoteSession(id: string): Promise<void> {
  sessionsState.openMenuId = null;
  endSessionDrag();
  try {
    await detachSession(id);
    await refreshSessions({ silent: true });
  } catch (error) {
    canvasToast(errMessage(error));
    renderList();
  }
}

function detachDropZone(): TemplateResult {
  return html`<div
    class="detach-drop-zone"
    @dragenter=${(e: DragEvent) => {
      if (!draggingChildId) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.add("over");
    }}
    @dragover=${(e: DragEvent) => {
      if (!draggingChildId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    }}
    @dragleave=${(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("over")}
    @drop=${(e: DragEvent) => {
      const id = draggingChildId;
      (e.currentTarget as HTMLElement).classList.remove("over");
      if (!id) return;
      e.preventDefault();
      endSessionDrag();
      void promoteSession(id);
    }}
  >
    ${icon(CornerLeftUp, 13)}<span>Drop to make a top-level session</span>
  </div>`;
}

const placeSessionMenu = (el?: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove("drop-up");
  const margin = 8;
  const scrollport = el.closest(".list")?.getBoundingClientRect();
  const bottomLimit = Math.min(window.innerHeight, scrollport?.bottom ?? Infinity) - margin;
  const topLimit = Math.max(0, scrollport?.top ?? 0) + margin;
  const rect = el.getBoundingClientRect();
  const anchorTop = el.parentElement?.getBoundingClientRect().top ?? rect.top;
  if (rect.bottom > bottomLimit && anchorTop - 4 - rect.height >= topLimit) {
    el.classList.add("drop-up");
  }
};

function sessionMenuPopover(s: CoreSession): TemplateResult {
  const archived = Boolean(s.archived);
  const pinned = Boolean(s.pinned);
  const refreshingTitle = refreshingTitleIds.has(s.id);
  return html`
    <div class="session-menu-popover" role="menu" ${ref(placeSessionMenu)} @click=${(e: Event) => e.stopPropagation()}>
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => void copySessionLink(s)}>
        ${icon(Link, 15)}<span>Copy link</span>
      </button>
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => setPinned(s, !pinned)}>
        ${pinned ? icon(PinOff, 15) : icon(Pin, 15)}<span>${pinned ? "Unpin" : "Pin"}</span>
      </button>
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => startRename(s)}>
        ${icon(Pencil, 15)}<span>Rename</span>
      </button>
      <button
        class="session-menu-option"
        type="button"
        role="menuitem"
        ?disabled=${refreshingTitle}
        @click=${() => void refreshSessionTitle(s)}
      >
        ${icon(RefreshCw, 15)}<span>${refreshingTitle ? "Refreshing title" : "Refresh title"}</span>
      </button>
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => setArchived(s, !archived)}>
        ${archived ? icon(ArchiveRestore, 15) : icon(Archive, 15)}<span>${archived ? "Unarchive" : "Archive"}</span>
      </button>
      ${sessionColorRow(s)}
    </div>
  `;
}

const SESSION_COLORS = ["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"] as const;
const LEGACY_SESSION_COLORS = new Map([
  ["#ef4444", SESSION_COLORS[0]],
  ["#f59e0b", SESSION_COLORS[1]],
  ["#22c55e", SESSION_COLORS[2]],
  ["#3b82f6", SESSION_COLORS[3]],
  ["#a855f7", SESSION_COLORS[4]],
  ["#ec4899", SESSION_COLORS[5]],
]);

function displaySessionColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const normalized = color.toLowerCase();
  return LEGACY_SESSION_COLORS.get(normalized) ?? normalized;
}

function sessionColorRow(s: CoreSession): TemplateResult {
  const current = displaySessionColor(s.color);
  const isPreset = SESSION_COLORS.includes(current as (typeof SESSION_COLORS)[number]);
  return html`
    <div class="session-menu-colors" role="group" aria-label="Row color">
      ${SESSION_COLORS.map(
        (c) => html`
          <button
            class="color-swatch ${current === c ? "selected" : ""}"
            type="button"
            style=${`--swatch:${c}`}
            aria-label=${`Color row ${c}`}
            aria-pressed=${current === c ? "true" : "false"}
            @click=${() => setColor(s, current === c ? null : c)}
          ></button>
        `,
      )}
      <label class="color-swatch custom ${current && !isPreset ? "selected" : ""}" ${tip("Custom color (RGB picker)")}>
        <input
          type="color"
          aria-label="Custom row color"
          value=${current ?? SESSION_COLORS[3]}
          @click=${(e: Event) => e.stopPropagation()}
          @input=${(e: InputEvent) => previewColor(s, (e.currentTarget as HTMLInputElement).value)}
          @change=${(e: Event) => setColor(s, (e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      ${
        current
          ? html`<button
              class="color-swatch clear"
              type="button"
              ${tip("Clear color")}
              aria-label="Clear row color"
              @click=${() => setColor(s, null)}
            >
              ${icon(X, 12)}
            </button>`
          : nothing
      }
    </div>
  `;
}

function renameRow(s: CoreSession): TemplateResult {
  return html`<div class="session-row renaming">
    ${renameInput(s.id, "Rename conversation", () => commitRename(s))}
  </div>`;
}

function renameInput(menuKey: string, ariaLabel: string, commit: () => Promise<void>): TemplateResult {
  return html`
    <input
      class="session-rename-input"
      aria-label=${ariaLabel}
      .value=${live(renameDraft)}
      @input=${(e: InputEvent) => {
        renameDraft = (e.currentTarget as HTMLInputElement).value;
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelRename(menuKey);
        }
      }}
      @blur=${() => void commit()}
      @click=${(e: Event) => e.stopPropagation()}
    />
  `;
}

function toggleShowArchived(): void {
  showArchived = !showArchived;
  if (showArchived && sessionsState.navigation && !sessionsState.navigation.archived)
    void loadNavigationSection("archived", false);
  renderList();
}

export function setWebOnly(webOnly: boolean): void {
  const changed = sessionsState.webOnly !== webOnly;
  sessionsState.webOnly = webOnly;
  try {
    localStorage.setItem(WEB_ONLY_KEY, webOnly ? "1" : "0");
  } catch {
    void 0;
  }
  if (changed && (sessionsState.navigation || sessionsRefreshRunning)) {
    navigationGeneration++;
    listAbort?.abort();
    for (const request of navigationRequests.values()) request.abort();
    navigationRequests.clear();
    groupPages.clear();
    void refreshSessions({ showLoading: true, resetPages: true });
  }
  renderList();
}

export function revealSessionSurface(s: CoreSession): void {
  if (!sessionsState.webOnly || surfaceOf(s) === "web") return;
  setWebOnly(false);
}

async function copySessionLink(s: CoreSession): Promise<void> {
  sessionsState.openMenuId = null;
  renderList();
  await copyText(sessionLink(location.origin, UI_BASE, s.id));
}

function toggleSessionMenu(e: Event, id: string): void {
  e.stopPropagation();
  sessionsState.openMenuId = sessionsState.openMenuId === id ? null : id;
  renderList();
}

function startRename(s: CoreSession): void {
  beginRename(s.id, sessionTitle(s));
}

function beginRename(key: string, draft: string): void {
  sessionsState.openMenuId = null;
  sessionsState.renamingId = key;
  renameDraft = draft;
  renderList();
  requestAnimationFrame(() => {
    const input = appState.listEl?.querySelector<HTMLInputElement>(".session-rename-input");
    if (!input) return;
    input.focus();
    input.select();
  });
}

function focusSessionMenuButton(menuKey: string): void {
  requestAnimationFrame(() => {
    const buttons = appState.listEl?.querySelectorAll<HTMLButtonElement>(".session-menu-btn") ?? [];
    [...buttons].find((button) => button.dataset.menuId === menuKey)?.focus();
  });
}

function cancelRename(menuKey: string): void {
  sessionsState.renamingId = null;
  renameDraft = "";
  renderList();
  focusSessionMenuButton(menuKey);
}

export function closeOpenSessionMenu(): boolean {
  const menuKey = sessionsState.openMenuId;
  if (!menuKey) return false;
  sessionsState.openMenuId = null;
  renderList();
  focusSessionMenuButton(menuKey);
  return true;
}

async function commitRename(s: CoreSession): Promise<void> {
  if (sessionsState.renamingId !== s.id) return;
  const next = renameDraft.trim();
  sessionsState.renamingId = null;
  renameDraft = "";
  renderList();
  const resolved = (s.title ?? "").trim();
  if (next === resolved) return;
  const desired = !next || next === defaultSessionTitle(s) ? null : next;
  if (desired === null && !resolved) return;
  await persistSessionPatch(s.id, { title: desired });
}

/** Archive a session by id — closes any surface showing it and updates the Recents list immediately. */
export function archiveSessionById(sessionId: string): void {
  const s = sessionsState.list.find((x) => x.id === sessionId);
  if (s && !s.archived) {
    setArchived(s, true);
    return;
  }
  closeSessionSurfaces(sessionId);
  if (!s) void persistSessionPatch(sessionId, { archived: true });
}

export function sessionSelectionBar(): TemplateResult | null {
  const n = selection.ids.size;
  if (!n) return null;
  const rows = sessionsState.list.filter((s) => selection.ids.has(s.id));
  const allArchived = rows.length > 0 && rows.every((s) => s.archived);
  const allPinned = rows.length > 0 && rows.every((s) => s.pinned);
  return html`
    <div
      class="section-label recents-label multi-select-bar"
      role="toolbar"
      aria-label=${`${n} conversations selected`}
    >
      <span class="multi-select-summary">
        <button
          class="icon-btn"
          type="button"
          ${tip("Clear selection (Esc)")}
          aria-label="Clear selection"
          @click=${() => clearSessionSelection()}
        >
          ${icon(X, 14)}
        </button>
        <span class="multi-select-count">${n} selected</span>
      </span>
      <span class="multi-select-actions">
        <button
          class="icon-btn"
          type="button"
          ${tip(allPinned ? "Unpin selected" : "Pin selected")}
          aria-label=${allPinned ? "Unpin selected conversations" : "Pin selected conversations"}
          @click=${() => void bulkPatch({ pinned: !allPinned })}
        >
          ${allPinned ? icon(PinOff, 14) : icon(Pin, 14)}
        </button>
        <span class="multi-select-color">
          <button
            class="icon-btn"
            type="button"
            ${tip("Color selected")}
            aria-label="Color selected conversations"
            aria-haspopup="true"
            aria-expanded=${selectColorOpen ? "true" : "false"}
            @click=${(e: Event) => {
              e.stopPropagation();
              selectColorOpen = !selectColorOpen;
              renderSidebarTop();
            }}
          >
            ${icon(Palette, 14)}
          </button>
        </span>
        <button
          class="icon-btn"
          type="button"
          ${tip(allArchived ? "Unarchive selected" : "Archive selected")}
          aria-label=${allArchived ? "Unarchive selected conversations" : "Archive selected conversations"}
          @click=${() => void bulkPatch({ archived: !allArchived })}
        >
          ${allArchived ? icon(ArchiveRestore, 14) : icon(Archive, 14)}
        </button>
      </span>
      ${selectColorOpen ? colorPopover() : nothing}
    </div>
  `;
}

export function closeSessionSelectionColor(): boolean {
  if (!selectColorOpen) return false;
  selectColorOpen = false;
  renderSidebarTop();
  return true;
}

function colorPopover(): TemplateResult {
  return html`
    <div
      class="session-menu-popover multi-select-color-popover"
      role="menu"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <div class="session-menu-colors" role="group" aria-label="Color selected conversations">
        ${SESSION_COLORS.map(
          (c) => html`
            <button
              class="color-swatch"
              type="button"
              style=${`--swatch:${c}`}
              ${tip(`Color selected ${c}`)}
              aria-label=${`Color selected conversations ${c}`}
              @click=${() => void bulkPatch({ color: c })}
            ></button>
          `,
        )}
        <button
          class="color-swatch clear"
          type="button"
          ${tip("Clear color")}
          aria-label="Clear color on selected conversations"
          @click=${() => void bulkPatch({ color: null })}
        >
          ${icon(Ban, 10)}
        </button>
      </div>
    </div>
  `;
}

async function bulkPatch(patch: SessionPatch): Promise<void> {
  const generation = sessionPatchGeneration;
  const ids = [...selection.ids];
  selectColorOpen = false;
  if (patch.archived !== undefined) selection = emptySelection();
  if (patch.archived) for (const id of ids) closeSessionSurfaces(id);
  sessionsState.list = sessionsState.list.map((s) => (ids.includes(s.id) ? { ...s, ...patch } : s));
  redrawSelection();
  const patches = ids.map((id) => queueSessionPatch(id, patch));
  const results = await Promise.allSettled(patches);
  if (
    sessionPatchGeneration === generation &&
    (sessionsState.navigation || results.some((r) => r.status === "rejected"))
  )
    await refreshSessions({ silent: true, patchEpoch: sessionPatchEpoch });
  redrawSelection();
}

function setArchived(s: CoreSession, archived: boolean): void {
  sessionsState.openMenuId = null;
  if (archived && s.id) closeSessionSurfaces(s.id);
  void persistSessionPatch(s.id, { archived });
}

function setPinned(s: CoreSession, pinned: boolean): void {
  sessionsState.openMenuId = null;
  void persistSessionPatch(s.id, { pinned });
}

function previewColor(s: CoreSession, color: string): void {
  sessionsState.list = sessionsState.list.map((x) => (x.id === s.id ? { ...x, color } : x));
  renderList();
}

function setColor(s: CoreSession, color: string | null): void {
  void persistSessionPatch(s.id, { color });
}

function applyResolvedSession(updated: CoreSession): void {
  sessionsState.list = sessionsState.list.map((s) =>
    s.id === updated.id
      ? {
          ...s,
          ...updated,
          title: updated.title ?? null,
          archived: Boolean(updated.archived),
          pinned: Boolean(updated.pinned),
          color: updated.color ?? null,
        }
      : s,
  );
}

async function refreshSessionTitle(s: CoreSession): Promise<void> {
  sessionsState.openMenuId = null;
  if (refreshingTitleIds.has(s.id)) {
    renderList();
    return;
  }
  refreshingTitleIds.add(s.id);
  renderList();
  try {
    const refreshed = await regenerateTitle(s.id);
    if (refreshed.title && !(s.title && s.title.trim())) {
      sessionsState.list = sessionsState.list.map((row) =>
        row.id === s.id ? { ...row, title: refreshed.title } : row,
      );
    }
    renderList();
  } catch {
    void 0;
  } finally {
    await refreshSessions({ silent: true });
    refreshingTitleIds.delete(s.id);
    renderList();
  }
}

async function persistSessionPatch(id: string, patch: SessionPatch): Promise<void> {
  const generation = sessionPatchGeneration;
  sessionsState.list = sessionsState.list.map((s) => (s.id === id ? { ...s, ...patch } : s));
  renderList();
  const request = queueSessionPatch(id, patch);
  try {
    await request;
    if (sessionsState.navigation && sessionPatchGeneration === generation)
      await refreshSessions({ silent: true, patchEpoch: sessionPatchEpoch });
    renderList();
  } catch {
    if (sessionPatchGeneration === generation) await refreshSessions({ silent: true, patchEpoch: sessionPatchEpoch });
  }
}

function queueSessionPatch(id: string, patch: SessionPatch): Promise<CoreSession> {
  sessionPatchEpoch++;
  const version = (sessionPatchVersions.get(id) ?? 0) + 1;
  const generation = sessionPatchGeneration;
  sessionPatchVersions.set(id, version);
  const prior = sessionPatchTails.get(id) ?? Promise.resolve();
  const request = prior
    .catch(() => undefined)
    .then(async () => {
      const { session } = await updateSession(id, patch);
      if (sessionPatchGeneration === generation && sessionPatchVersions.get(id) === version)
        applyResolvedSession(session);
      return session;
    });
  sessionPatchTails.set(
    id,
    request.then(
      () => undefined,
      () => undefined,
    ),
  );
  void request.then(
    () => {
      if (sessionPatchGeneration === generation) sessionPatchEpoch++;
    },
    () => {
      if (sessionPatchGeneration === generation) sessionPatchEpoch++;
    },
  );
  return request;
}

let listSettled: (() => void) | null = null;
const listReady = new Promise<void>((resolve) => (listSettled = resolve));

export function sessionsReady(): Promise<void> {
  return sessionsState.loaded ? Promise.resolve() : listReady;
}

function openConversationIds(): string[] {
  const opening = sessionsState.openingKey ? [sessionsState.openingKey] : [];
  return [...opening, ...allConversations().flatMap((conv) => (conv.state.sessionId ? [conv.state.sessionId] : []))];
}

type SessionsRefreshOptions = {
  showLoading?: boolean;
  silent?: boolean;
  refreshContexts?: boolean;
  resetPages?: boolean;
  patchEpoch?: number;
};
let latestSessionsRefresh: Promise<boolean> | null = null;
let queuedSessionsRefresh: SessionsRefreshOptions | null = null;
let sessionsRefreshRunning = false;
let listRequestedAt = 0;
let listDiscards = 0;
const LIST_STALL_MS = 10_000;

export function refreshSessionsOnOpen(): void {
  const joinable =
    sessionsRefreshRunning && Date.now() - listRequestedAt < LIST_STALL_MS ? latestSessionsRefresh : null;
  if (!joinable) {
    void refreshSessions({ silent: true });
    return;
  }
  const discards = listDiscards;
  void joinable.then(
    (applied) => {
      if (applied || listDiscards === discards || latestSessionsRefresh !== joinable) return;
      void refreshSessions({ silent: true });
    },
    () => void 0,
  );
}

export function refreshSessions(opts: SessionsRefreshOptions = {}): Promise<boolean> {
  if (sessionsRefreshRunning && Date.now() - listRequestedAt < LIST_STALL_MS && latestSessionsRefresh) {
    queuedSessionsRefresh = {
      ...opts,
      showLoading: queuedSessionsRefresh?.showLoading || opts.showLoading,
      refreshContexts: queuedSessionsRefresh?.refreshContexts || opts.refreshContexts,
      resetPages: queuedSessionsRefresh?.resetPages || opts.resetPages,
      silent: queuedSessionsRefresh ? queuedSessionsRefresh.silent && opts.silent : opts.silent,
    };
    sessionRefreshSeq++;
    return latestSessionsRefresh;
  }
  sessionsRefreshRunning = true;
  const isLatest = (): boolean => latestSessionsRefresh === run;
  const run: Promise<boolean> = (async () => {
    try {
      let next: SessionsRefreshOptions | null = opts;
      let applied: boolean;
      do {
        queuedSessionsRefresh = null;
        applied = await runSessionsRefresh(next, () => (isLatest() ? null : latestSessionsRefresh));
        next = isLatest() ? queuedSessionsRefresh : null;
      } while (next);
      return applied;
    } finally {
      if (isLatest()) sessionsRefreshRunning = false;
    }
  })();
  latestSessionsRefresh = run;
  return run;
}

async function runSessionsRefresh(
  opts: SessionsRefreshOptions,
  newerRun: () => Promise<boolean> | null,
): Promise<boolean> {
  const seq = ++sessionRefreshSeq;
  listAbort?.abort();
  const controller = new AbortController();
  listAbort = controller;
  const patchEpoch = opts.patchEpoch ?? sessionPatchEpoch;
  const previous = opts.resetPages ? null : sessionsState.navigation;
  const previousGroups = opts.resetPages ? new Map<string, SessionPageResult<CoreSession>>() : new Map(groupPages);
  const refreshedGroups = new Map<string, SessionPageResult<CoreSession>>();
  for (const request of navigationRequests.values()) request.abort();
  navigationRequests.clear();
  const current = () => {
    controller.signal.throwIfAborted();
    if (seq !== sessionRefreshSeq || patchEpoch !== sessionPatchEpoch)
      throw new DOMException("Navigation cancelled", "AbortError");
  };
  if (opts.showLoading) {
    sessionsLoading = true;
    sessionsNotice = "";
    renderList();
  }
  listRequestedAt = Date.now();
  renderList();
  try {
    const navigation = await fetchNavigation(
      {
        surface: sessionsState.webOnly ? "web" : "all",
        references: navigationReferences(),
        ...(showArchived ? { section: "archived" as const } : {}),
      },
      controller.signal,
    );
    if (navigation) {
      for (const section of ["recent", "pinned", "groups", "archived"] as const) {
        const pages = Math.ceil((previous?.[section]?.items.length ?? 0) / 50);
        for (let i = 1; navigation[section]?.nextCursor && i < pages; i++) {
          current();
          const prior = navigation[section]!;
          const result = await fetchNavigation(
            { surface: sessionsState.webOnly ? "web" : "all", section, cursor: prior.nextCursor! },
            controller.signal,
          );
          current();
          if (!result) throw new Error("Session navigation became unavailable");
          const page = result[section]!;
          if (page.nextCursor === prior.nextCursor) throw new Error("Session cursor did not advance");
          Object.assign(navigation, {
            [section]: {
              ...page,
              items: [
                ...new Map(
                  [...prior.items, ...page.items].map((row) => ["id" in row ? row.id : row.scopeId, row]),
                ).values(),
              ],
            },
          });
          navigation.contexts.push(...result.contexts);
        }
      }
      for (const [scopeId, prior] of previousGroups) {
        current();
        const page = await readSessionWindow(
          { scopeId, archived: false, pinned: false, surface: sessionsState.webOnly ? "web" : "all" },
          prior.items.length,
          controller.signal,
        );
        current();
        if (!page) throw new Error("Session navigation became unavailable");
        refreshedGroups.set(scopeId, page);
      }
    }
    if (!navigation) loadRecentContexts(opts.refreshContexts === true);
    const r = navigation
      ? null
      : await api<{ sessions: CoreSession[] }>("/api/sessions", { signal: controller.signal });
    if (seq !== sessionRefreshSeq) return sessionsState.loaded || ((await newerRun()) ?? false);
    if (patchEpoch !== sessionPatchEpoch) {
      listDiscards++;
      return false;
    }
    if (navigation) {
      navigationGeneration++;
      for (const request of navigationRequests.values()) request.abort();
      navigationRequests.clear();
      groupPages.clear();
      for (const [scopeId, page] of refreshedGroups) groupPages.set(scopeId, page);
      sessionsState.navigation = navigation;
      rememberContexts(navigation.contexts);
      rememberSessions([
        ...navigation.recent.items,
        ...navigation.pinned.items,
        ...(navigation.archived?.items ?? []),
        ...navigation.references.flatMap((ref) => (ref.session ? [ref.session] : [])),
        ...(navigation.startup.latest ? [navigation.startup.latest] : []),
      ]);
      for (const row of navigation.references)
        if (row.session === null)
          sessionsState.list = sessionsState.list.filter(
            (session) =>
              !session.id ||
              (row.reference.kind === "id"
                ? session.id !== row.reference.value
                : session.threadRef !== row.reference.value),
          );
    } else {
      if (!r || !Array.isArray(r.sessions)) throw new Error("Invalid session list response");
      sessionsState.navigation = null;
      sessionsState.list = reconcileSessions(r.sessions, sessionsState.list, openConversationIds());
    }
    sessionsState.loaded = true;
    sessionsNotice = "";
    return true;
  } catch (e) {
    if (seq !== sessionRefreshSeq) return sessionsState.loaded || ((await newerRun()) ?? false);
    if (!opts.silent) sessionsNotice = errMessage(e, "Failed to load conversations.");
    return false;
  } finally {
    if (seq === sessionRefreshSeq) {
      if (listAbort === controller) listAbort = null;
      listSettled?.();
      listSettled = null;
      sessionsLoading = false;
      renderList();
      for (const conversation of allConversations()) conversation.redraw();
    }
  }
}

export async function openSession(
  s: CoreSession,
  entriesPrefetch?: Promise<TranscriptPage | null>,
  approvalsPrefetch?: Promise<{ approvals: PendingApproval[] } | null>,
): Promise<void> {
  if (appState.currentView !== "chats") {
    appState.currentView = "chats";
    appState.viewRenderSeq++;
    renderSidebarTop();
    renderList();
    if (splitState.active) drawCanvas();
    syncUrlFromState(s.id || null);
  }
  cancelSessionPageRead();
  chatsPageHost = null;
  mountRestoredCanvas();
  const pane = splitInterceptsOpen(s);
  closeSidebarOnNarrowView();
  if (projectName(s.scopeId) && sessionsState.collapsedProjectScopes.delete(s.scopeId)) renderList();
  return openSessionInto(pane ?? mainConversation(), s, entriesPrefetch, approvalsPrefetch, true);
}

const sessionReads = new WeakMap<
  Conversation,
  {
    sessionId: string;
    isCurrent: () => boolean;
    entries: Promise<TranscriptPage | null>;
    approvals: Promise<{ approvals: PendingApproval[] } | null> | null;
  }
>();

export async function openSessionInto(
  conv: Conversation,
  source: CoreSession | string,
  entriesPrefetch?: Promise<TranscriptPage | null>,
  approvalsPrefetch?: Promise<{ approvals: PendingApproval[] } | null>,
  tracked = conv === mainConversation(),
): Promise<void> {
  if (typeof source !== "string" && !source.id) {
    if (conv.state.threadRef !== source.threadRef) {
      conv.mountContinuable(source.threadRef, null, source.scopeId || null, [], source.channelName ?? null);
      renderList();
    }
    return;
  }
  const sessionId = typeof source === "string" ? source : source.id;
  if (sessionId === conv.state.sessionId && !entriesPrefetch) return;

  if (tracked) refreshSessionsOnOpen();

  const opening = sessionId;
  if (tracked) {
    sessionsState.openingKey = opening;
    renderList();
  }
  if (!isLiveConversation(conv)) return;
  const pending = sessionReads.get(conv);
  const shared =
    !entriesPrefetch && !approvalsPrefetch && pending?.sessionId === sessionId && pending.isCurrent()
      ? pending
      : undefined;
  const isCurrent = conv.mountLoadingPane();

  const fetchEntries = (): Promise<TranscriptPage | null> =>
    fetchTranscript(sessionId, { tailTurns: TAIL_TURNS }).catch(() => null);
  const read = {
    sessionId,
    isCurrent,
    entries: shared?.entries ?? (entriesPrefetch ? entriesPrefetch.then((r) => r ?? fetchEntries()) : fetchEntries()),
    approvals:
      shared?.approvals ??
      (typeof source === "string" || isContinuable(source, appState.me?.user ?? "")
        ? (approvalsPrefetch ?? fetchSessionApprovals(sessionId))
        : null),
  };
  sessionReads.set(conv, read);
  const [entriesRes, approvalsRes] = await Promise.all([
    read.entries,
    read.entries.then((page) => {
      const session = typeof source === "string" ? page?.session : source;
      return session && isContinuable(session, appState.me?.user ?? "") ? read.approvals : null;
    }),
  ]).finally(() => {
    if (sessionReads.get(conv) === read) sessionReads.delete(conv);
  });
  if (!isLiveConversation(conv) || !isCurrent()) return;

  if (tracked) {
    if (sessionsState.openingKey !== opening) return;
    sessionsState.openingKey = null;
  }
  if (!entriesPrefetch && conv.state.sessionId === sessionId) {
    renderList();
    return;
  }

  const s = typeof source === "string" ? entriesRes?.session : source;
  if (!entriesRes || !s) {
    conv.mountLoadError(() => void openSessionInto(conv, source, undefined, undefined, tracked));
    renderList();
    return;
  }

  rememberSessions([s]);
  if (s.parentSessionId && !sessionsState.list.some((row) => row.id === s.parentSessionId)) {
    void resolveSessionReference({ kind: "id", value: s.parentSessionId })
      .then(() => {
        if (isLiveConversation(conv)) conv.redraw();
      })
      .catch(() => undefined);
  }
  const split = inheritedTranscript(s, entriesRes.entries ?? []);
  const messages = entriesToMessages(split.current, transcriptModel());
  const inheritedMessages = entriesToMessages(split.inherited, transcriptModel());
  const earlier = currentEarlierCount(s, entriesRes.earlierEntries ?? 0);
  const anchorSeq = entriesRes.entries?.[0]?.seq ?? null;
  const continuable = isContinuable(s, appState.me?.user ?? "");
  if (continuable) {
    attachPendingApprovals(messages, approvalsRes?.approvals ?? [], transcriptModel());
    conv.mountContinuable(s.threadRef, s.id, s.scopeId, messages, s.channelName ?? null, s, inheritedMessages);
    conv.setTranscriptWindow(anchorSeq, earlier, (entriesRes.earlierEntries ?? 0) > 0);
  } else {
    conv.mountReadOnly(s, messages, earlier, anchorSeq, inheritedMessages);
  }
  conv.setPins(entriesRes.pins ?? []);
  renderList();
}
