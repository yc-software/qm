import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  Archive,
  Binoculars,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Cog,
  EllipsisVertical,
  Folder,
  Hash,
  Link,
  Lock,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  SquareTerminal,
  User,
  Users,
  X,
} from "lucide";
import {
  api,
  attachPendingApprovals,
  fetchTranscript,
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
import { sessionLink, UI_BASE } from "./deep-link";
import {
  activityOf,
  chatBrowseStatusMatches,
  bumpActivity,
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
import { hideTooltip, showTooltip } from "./tooltip";
import { errMessage } from "../../chassis/src/errors";
import { copyText, fieldSelect, icon, relTime } from "./ui";
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
import { appState, closeSidebarOnNarrowView, renderSidebarTop, showMainEmpty } from "./shell";
import { allConversations, mainConversation } from "./conversations";
import type { Conversation } from "./conv-types";
import {
  addBlankPane,
  beginSessionDrag,
  endSessionDrag,
  notifySessionsChanged,
  sessionInCanvas,
  splitInterceptsOpen,
  splitState,
} from "./split";
import { liveTurnThreadRef } from "./working-dot";

export const sessionsState = {
  list: [] as CoreSession[],
  loaded: false,
  openMenuId: null as string | null,
  renamingId: null as string | null,
  openingKey: null as string | null,
  webOnly: true,
  collapsedProjectScopes: new Set<string>(),
};

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

let chatsPageScope: string | null = null;
let chatsPageQuery = "";
let chatsPageStatus: ChatBrowseStatus = "active";
let chatsPageSurface: "all" | "web" | "slack" = "all";
let chatsPageHost: HTMLElement | null = null;

export function resetSessionsState(): void {
  sessionsState.list = [];
  sessionsState.loaded = false;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  sessionsState.openingKey = null;
  sessionsState.collapsedProjectScopes.clear();
  renameDraft = "";
  refreshingTitleIds.clear();
  showArchived = false;
  chatsPageScope = null;
  chatsPageQuery = "";
  chatsPageStatus = "active";
  chatsPageSurface = "all";
  chatsPageHost = null;
  recentContextsRequest = null;
}

function projectSeedsForRecents() {
  return recentProjectSeeds(contextsState.list);
}

function recentItemActivity(item: RecentItem): number {
  if (item.kind === "session") return activityOf(item.session);
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

export function surfaceOf(s: CoreSession): string {
  if (s.threadRef.startsWith("web:")) return "web";
  if (s.threadRef.startsWith("dm:") || s.threadRef.startsWith("ch:")) return "slack";
  return "core";
}

export function sessionSlackUrl(s: Pick<CoreSession, "threadRef">): string | null {
  return slackThreadUrl(appState.me?.slackWorkspaceUrl ?? null, s.threadRef);
}

function projectName(scopeId: string): string | null {
  return projectOf(scopeId)?.name ?? null;
}

function projectOf(scopeId: string): CoreProject | null {
  return contextsState.list.find((context) => context.scopeId === scopeId)?.project ?? null;
}

function projectMenuKey(scopeId: string): string {
  return `project:${scopeId}`;
}

export function defaultSessionTitle(s: CoreSession): string {
  const project = projectName(s.scopeId);
  if (project) return project;
  const surface = surfaceOf(s);
  if (surface === "web") return "Web chat";
  if (s.type === "channel") return channelLabel(s) ?? "Channel";
  if (s.type === "group") return groupDmText(s.channelName) ?? s.channelName?.trim() ?? "Group DM";
  return "Direct message";
}

function channelLabel(s: CoreSession): string | null {
  return s.channelName && s.channelName.trim() ? `#${s.channelName.replace(/^#/, "")}` : null;
}

export function groupDmTitle(s: CoreSession): TemplateResult | string {
  if (s.title && s.title.trim()) return s.title;
  if (projectName(s.scopeId)) return defaultSessionTitle(s);
  if (s.type !== "group") return defaultSessionTitle(s);
  const label = groupDmLabel(s.channelName);
  if (!label) return defaultSessionTitle(s);
  return html`<span class="group-dm-title" title=${label.text}>
    <span class="group-dm-count">${label.count}</span>
    <span class="group-dm-names">${label.text}</span>
  </span>`;
}

export function sessionTitle(s: CoreSession): string {
  return s.title && s.title.trim() ? s.title : defaultSessionTitle(s);
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
  const sorted = [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a));
  return sessionsState.webOnly ? sorted.filter((s) => surfaceOf(s) === "web") : sorted;
}

export function renderList(): void {
  if (!appState.listEl || appState.currentView !== "chats") return;
  const visible = visibleSessions();
  const active = visible.filter((s) => !s.archived);
  const archived = visible.filter((s) => s.archived);
  const { pinned, rest } = splitPinned(active);
  const activeItems = recentItemsFor(rest);
  const archivedItems: RecentItem[] = archived.map((session) => ({ kind: "session", session }));
  armMidnightRefresh();
  render(
    html`
      ${
        pinned.length
          ? html`
              <div class="recents-group pinned-head">${icon(Pin, 11)}<span>Pinned</span></div>
              ${repeat(
                pinned,
                (session) => session.threadRef,
                (session) => sessionRow(session),
              )}
            `
          : nothing
      }
      ${groupedRows(activeItems)}
      ${
        archived.length
          ? html`
              <button class="archived-toggle ${showArchived ? "open" : ""}" @click=${toggleShowArchived}>
                ${icon(showArchived ? ChevronDown : ChevronRight, 14)} ${icon(Archive, 14)}
                <span>Archived</span>
                <span class="archived-count">${archived.length}</span>
              </button>
              ${showArchived ? groupedRows(archivedItems) : nothing}
            `
          : nothing
      }
      ${sessionsNotice ? html`<div class="empty" style="padding:16px">${sessionsNotice}</div>` : ""}
      ${sessionsLoading && visible.length === 0 ? html`<div class="empty" style="padding:16px">Loading conversations...</div>` : ""}
      ${
        !sessionsLoading && !sessionsNotice && visible.length === 0
          ? html`<div class="empty" style="padding:16px">
              ${sessionsState.list.length ? "Slack conversations hidden." : "No conversations yet."}
            </div>`
          : ""
      }
    `,
    appState.listEl,
  );
  if (sessionsState.openMenuId) {
    requestAnimationFrame(() => placeSessionMenu(appState.listEl?.querySelector(".session-menu-popover") ?? undefined));
  }
  notifySessionsChanged();
}

function recentItem(item: RecentItem): TemplateResult {
  if (item.kind === "session") return sessionRow(item.session);
  const collapsed = sessionsState.collapsedProjectScopes.has(item.scopeId);
  let glyph = Folder;
  if (item.groupKind === "personal") glyph = User;
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
    <section class="recent-project ${item.sessions.some(isActiveRow) ? "active" : ""}" aria-label=${`${name} project`}>
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
                ${icon(collapsed ? ChevronRight : ChevronDown, 13)} ${icon(glyph, 14)}
                <span class="recent-project-name">${name.replace(/^#/, "")}</span>
              </button>
              <div class="session-menu recent-project-menu ${menuOpen ? "menu-open" : ""}">
                <span class="recent-project-count">${item.sessions.length}</span>
                <button
                  class="session-menu-btn"
                  data-menu-id=${menuKey}
                  type="button"
                  title="Project options"
                  aria-label=${`Options for ${name}`}
                  aria-haspopup="menu"
                  aria-expanded=${menuOpen ? "true" : "false"}
                  @click=${(e: Event) => toggleSessionMenu(e, menuKey)}
                >
                  ${icon(EllipsisVertical, 17)}
                </button>
                ${menuOpen ? projectMenuPopover(item) : nothing}
              </div>
              <button
                class="recent-project-new-chat"
                type="button"
                aria-label=${`New chat in ${name}`}
                title=${`New chat in ${name}`}
                @click=${(event: Event) => startProjectChat(event, item.scopeId, item.name)}
              >
                ${icon(Plus, 14)}
              </button>
            </div>`
      }
      <div class="recent-project-children" id=${childrenId} ?hidden=${collapsed}>
        ${repeat(
          item.sessions,
          (session) => session.threadRef,
          (session) => sessionRow(session, true),
        )}
      </div>
    </section>
  `;
}

function toggleRecentProject(scopeId: string): void {
  if (sessionsState.collapsedProjectScopes.has(scopeId)) sessionsState.collapsedProjectScopes.delete(scopeId);
  else sessionsState.collapsedProjectScopes.add(scopeId);
  renderList();
}

function startProjectChat(event: Event, scopeId: string, name: string | null): void {
  event.stopPropagation();
  closeSidebarOnNarrowView();
  sessionsState.collapsedProjectScopes.delete(scopeId);
  if (addBlankPane(scopeId)) return;
  addPendingSession(mainConversation().newChat({ scopeId, name }), scopeId, name);
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
  renderList();
}

export async function renderChatsPage(): Promise<void> {
  if (appState.currentView !== "chats") return;
  await ensureContexts();
  drawChatsPage();
  await refreshSessions({ showLoading: sessionsState.list.length === 0, silent: sessionsState.list.length > 0 });
  if (appState.currentView === "chats") drawChatsPage();
}

export function drawChatsPage(): void {
  if (appState.currentView !== "chats" || !appState.mainEl || splitState.active) return;
  mainConversation().state.host = null;
  if (!chatsPageHost || chatsPageHost.parentElement !== appState.mainEl) {
    chatsPageHost = document.createElement("div");
    chatsPageHost.className = "pane chats-page";
    appState.mainEl.replaceChildren(chatsPageHost);
  }
  const q = chatsPageQuery.trim().toLowerCase();
  const rows = [...sessionsState.list]
    .filter((s) => chatBrowseStatusMatches(s, chatsPageStatus))
    .filter((s) => chatsPageSurface === "all" || surfaceOf(s) === chatsPageSurface)
    .filter((s) => (chatsPageScope ? s.scopeId === chatsPageScope : true))
    .filter((s) => !q || chatMatches(s, q))
    .sort((a, b) => activityOf(b) - activityOf(a))
    .map((s) => chatPageRow(s));
  let empty = "No conversations yet — start a new chat.";
  if (sessionsLoading && sessionsState.list.length === 0) empty = "Loading conversations…";
  else if (chatsPageScope || q || chatsPageStatus !== "active" || chatsPageSurface !== "all") {
    empty = "No conversations match.";
  }
  render(
    listPageTpl({
      title: "Chats",
      scope: chatsPageScope,
      onScope: (s) => {
        chatsPageScope = s;
        drawChatsPage();
      },
      onRefresh: () => void renderChatsPage(),
      action: { label: "New chat", onClick: () => mainConversation().newChat() },
      search: {
        value: chatsPageQuery,
        placeholder: "Search chats…",
        onInput: (v) => {
          chatsPageQuery = v;
          drawChatsPage();
        },
      },
      filters: html`<div class="chat-filters">
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
                  drawChatsPage();
                }}
              >
                ${label}<span
                  >${sessionsState.list.filter((session) => chatBrowseStatusMatches(session, value)).length}</span
                >
              </button>`,
          )}
        </div>
        <label class="list-select"
          ><span>Surface</span>${fieldSelect({
            compact: true,
            value: chatsPageSurface,
            onChange: (value) => {
              chatsPageSurface = value as typeof chatsPageSurface;
              drawChatsPage();
            },
            options: [
              html`<option value="all">All surfaces</option>`,
              html`<option value="web">Web</option>`,
              html`<option value="slack">Slack</option>`,
            ],
          })}</label
        >
      </div>`,
      rows,
      empty,
    }),
    chatsPageHost,
  );
}

function chatMatches(s: CoreSession, q: string): boolean {
  const context = sharedContextLabel(s.scopeId, s.channelName ?? null) ?? "Personal";
  return [sessionTitle(s), s.channelName ?? "", context].join(" ").toLowerCase().includes(q);
}

export const syncWorkingPulse = (el?: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  const pin = (): void => {
    for (const a of el.getAnimations()) a.startTime = 0;
  };
  if (el.getAnimations().length > 0) pin();
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
  const ind = rowIndicators(s, liveThreads());
  return html`${ind.working ? html`<span class="working-dot" ${ref(syncWorkingPulse)} title="Agent is working" aria-label="Agent is working"></span>` : nothing}${
    ind.awaiting
      ? html`<span class="awaiting-dot" title="Waiting for your reply" aria-label="Waiting for your reply"></span>`
      : nothing
  }${
    ind.background
      ? html`<span
          class="bg-chip"
          role="button"
          tabindex="0"
          aria-label="${ind.background.label} — click to inspect"
          @mouseenter=${(e: Event) =>
            showTooltip(e.currentTarget as Element, `${ind.background!.label} — click to inspect`)}
          @mouseleave=${(e: Event) => hideTooltip(e.currentTarget as Element)}
          @focus=${(e: Event) => showTooltip(e.currentTarget as Element, `${ind.background!.label} — click to inspect`)}
          @blur=${(e: Event) => hideTooltip(e.currentTarget as Element)}
          @click=${(e: Event) => openBackgroundInspector(e, s)}
          @keydown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && openBackgroundInspector(e, s)}
          >${ind.background.jobs > 0 ? icon(Cog, 11) : nothing}${
            ind.background.watches > 0 ? icon(Binoculars, 11) : nothing
          }</span
        >`
      : nothing
  }`;
}

function openBackgroundInspector(e: Event, s: CoreSession): void {
  e.stopPropagation();
  e.preventDefault();
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
  const active = isActiveRow(s);
  const readOnly = !isContinuable(s, appState.me?.user ?? "");
  return html`
    <div
      class="list-row chat-row ${active ? "active" : ""} ${s.color ? "colored" : ""}"
      style=${s.color ? `--session-color:${s.color}` : nothing}
    >
      <button class="chat-row-open" type="button" @click=${() => void openSession(s)}>
        <span class="list-row-title">${statusMarks(s)}${groupDmTitle(s)}</span>
        <span class="list-row-meta">
          ${scopeChip(s.scopeId, s.channelName ?? null)}
          ${surfaceOf(s) === "slack" ? html`<span class="surface surface-slack">${slackLogo(13)}</span>` : nothing}
          ${readOnly ? html`<span class="ro-lock" title="Read-only">${icon(Lock, 12)}</span>` : nothing}
          <span class="list-row-date">${listWhen(activityOf(s))}</span>
        </span>
      </button>
      ${
        s.id
          ? html`<span class="chat-row-actions">
              <button
                class="icon-btn"
                type="button"
                title="Copy link"
                aria-label=${`Copy link to ${sessionTitle(s)}`}
                @click=${() => void copyText(sessionLink(location.origin, UI_BASE, s.id))}
              >
                ${icon(Link, 14)}
              </button>
              <button
                class="icon-btn"
                type="button"
                title=${s.pinned ? "Unpin" : "Pin"}
                aria-label=${`${s.pinned ? "Unpin" : "Pin"} ${sessionTitle(s)}`}
                @click=${() => {
                  setPinned(s, !s.pinned);
                  drawChatsPage();
                }}
              >
                ${s.pinned ? icon(PinOff, 14) : icon(Pin, 14)}
              </button>
              <button
                class="icon-btn"
                type="button"
                title=${s.archived ? "Unarchive" : "Archive"}
                aria-label=${`${s.archived ? "Unarchive" : "Archive"} ${sessionTitle(s)}`}
                @click=${() => {
                  setArchived(s, !s.archived);
                  drawChatsPage();
                }}
              >
                ${s.archived ? icon(ArchiveRestore, 14) : icon(Archive, 14)}
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

function groupedRows(list: RecentItem[]): TemplateResult {
  const now = Date.now();
  const items: { key: string; tpl: TemplateResult }[] = [];
  let group: string | null = null;
  for (const item of list) {
    const dateless = item.kind === "project" && item.sessions.length === 0;
    const g = recencyGroup(recentItemActivity(item), now);
    if (!dateless && g !== group) {
      group = g;
      items.push({ key: `group:${g}`, tpl: html`<div class="recents-group">${g}</div>` });
    }
    const key = item.kind === "session" ? item.session.threadRef : `project:${item.scopeId}`;
    items.push({ key, tpl: recentItem(item) });
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
    relTime(activityOf(s)),
  ]
    .filter(Boolean)
    .join(", ");
  return html`
    <div
      class="session-row ${active ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${readOnly ? "read-only" : ""} ${refreshingTitle ? "title-refreshing" : ""} ${working ? "working" : ""} ${s.awaitingInput ? "awaiting-input" : ""} ${projectChild ? "project-child" : ""} ${s.color ? "colored" : ""}"
      style=${s.color ? `--session-color:${s.color}` : nothing}
    >
      <button
        class="session"
        aria-busy=${refreshingTitle ? "true" : "false"}
        aria-label=${ariaLabel}
        draggable=${saved ? "true" : "false"}
        @dragstart=${(e: DragEvent) => onSessionDragStart(e, s)}
        @dragend=${() => endSessionDrag()}
        @click=${() => openSession(s)}
        @dblclick=${(e: Event) => {
          if (!saved) return;
          e.preventDefault();
          startRename(s);
        }}
      >
        <div class="title" aria-live="polite">
          ${statusMarks(s)}${surfaceGlyph(s)}${readOnly ? html`<span class="ro-lock" title="Read-only">${icon(Lock, 12)}</span>` : nothing}<span
            class="tl"
            >${titleContent}</span
          >${context ? html`<span class="row-context" title=${context}>${context}</span>` : nothing}
        </div>
      </button>
      ${
        saved
          ? html`<div class="session-menu">
              <button
                class="session-menu-btn session-archive-btn"
                type="button"
                title=${s.archived ? "Unarchive" : "Archive"}
                aria-label=${`${s.archived ? "Unarchive" : "Archive"} ${sessionTitle(s)}`}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  setArchived(s, !s.archived);
                }}
              >
                ${s.archived ? icon(ArchiveRestore, 15) : icon(Archive, 15)}
              </button>
              <button
                class="session-menu-btn"
                data-menu-id=${s.id}
                type="button"
                title="Conversation options"
                aria-haspopup="menu"
                aria-expanded=${menuOpen ? "true" : "false"}
                @click=${(e: Event) => toggleSessionMenu(e, s.id)}
              >
                ${icon(EllipsisVertical, 17)}
              </button>
              ${menuOpen ? sessionMenuPopover(s) : nothing}
            </div>`
          : nothing
      }
    </div>
  `;
}

function onSessionDragStart(e: DragEvent, s: CoreSession): void {
  if (!s.id) {
    e.preventDefault();
    return;
  }
  e.dataTransfer?.setData("application/x-webui-session", s.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  beginSessionDrag(s);
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

const SESSION_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"] as const;

function sessionColorRow(s: CoreSession): TemplateResult {
  const current = s.color?.toLowerCase() ?? null;
  const isPreset = SESSION_COLORS.includes(current as (typeof SESSION_COLORS)[number]);
  return html`
    <div class="session-menu-colors" role="group" aria-label="Row color">
      ${SESSION_COLORS.map(
        (c) => html`
          <button
            class="color-swatch ${current === c ? "selected" : ""}"
            type="button"
            style=${`--swatch:${c}`}
            title=${`Color row ${c}`}
            aria-label=${`Color row ${c}`}
            aria-pressed=${current === c ? "true" : "false"}
            @click=${() => setColor(s, current === c ? null : c)}
          ></button>
        `,
      )}
      <label class="color-swatch custom ${current && !isPreset ? "selected" : ""}" title="Custom color (RGB picker)">
        <input
          type="color"
          aria-label="Custom row color"
          value=${current ?? "#6366f1"}
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
              title="Clear color"
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
  renderList();
}

export function toggleWebOnly(): void {
  sessionsState.webOnly = !sessionsState.webOnly;
  try {
    localStorage.setItem(WEB_ONLY_KEY, sessionsState.webOnly ? "1" : "0");
  } catch {
    void 0;
  }
  renderSidebarTop();
  renderList();
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

function setArchived(s: CoreSession, archived: boolean): void {
  sessionsState.openMenuId = null;
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

async function persistSessionPatch(
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null },
): Promise<void> {
  sessionsState.list = sessionsState.list.map((s) => (s.id === id ? { ...s, ...patch } : s));
  renderList();
  try {
    const { session } = await updateSession(id, patch);
    applyResolvedSession(session);
    renderList();
  } catch {
    await refreshSessions({ silent: true });
  }
}

let listSettled: (() => void) | null = null;
const listReady = new Promise<void>((resolve) => (listSettled = resolve));

export function sessionsReady(): Promise<void> {
  return sessionsState.loaded ? Promise.resolve() : listReady;
}

export async function refreshSessions(
  opts: { showLoading?: boolean; silent?: boolean; refreshContexts?: boolean } = {},
): Promise<boolean> {
  loadRecentContexts(opts.refreshContexts === true);
  const seq = ++sessionRefreshSeq;
  if (opts.showLoading) {
    sessionsLoading = true;
    sessionsNotice = "";
    renderList();
  }
  try {
    const r = await api<{ sessions: CoreSession[] }>("/api/sessions");
    if (seq !== sessionRefreshSeq) return false;
    sessionsState.list = reconcileSessions(r.sessions ?? [], sessionsState.list);
    sessionsState.loaded = true;
    sessionsNotice = "";
    return true;
  } catch (e) {
    if (seq !== sessionRefreshSeq) return false;
    if (!opts.silent) sessionsNotice = errMessage(e, "Failed to load conversations.");
    return false;
  } finally {
    listSettled?.();
    listSettled = null;
    if (seq === sessionRefreshSeq) {
      sessionsLoading = false;
      renderList();
    }
  }
}

export async function openSession(s: CoreSession, entriesPrefetch?: Promise<TranscriptPage | null>): Promise<void> {
  if (splitInterceptsOpen(s)) return;
  closeSidebarOnNarrowView();
  if (projectName(s.scopeId) && sessionsState.collapsedProjectScopes.delete(s.scopeId)) renderList();
  return openSessionInto(mainConversation(), s, entriesPrefetch);
}

export async function openSessionInto(
  conv: Conversation,
  s: CoreSession,
  entriesPrefetch?: Promise<TranscriptPage | null>,
): Promise<void> {
  const tracked = conv === mainConversation();
  if (!s.id) {
    if (conv.state.threadRef !== s.threadRef) {
      conv.mountContinuable(s.threadRef, null, s.scopeId || null, [], s.channelName ?? null);
      renderList();
    }
    return;
  }
  if (s.id === conv.state.sessionId) return;

  void refreshSessions({ silent: true });

  const opening = s.id;
  if (tracked) {
    sessionsState.openingKey = opening;
    renderList();
  }
  const skeletonTimer = window.setTimeout(() => {
    if (!tracked || sessionsState.openingKey === opening) conv.mountLoadingPane();
  }, 140);

  const fetchEntries = (): Promise<TranscriptPage | null> =>
    fetchTranscript(s.id, { tailTurns: TAIL_TURNS }).catch(() => null);
  const continuable = isContinuable(s, appState.me?.user ?? "");
  const [entriesRes, approvalsRes] = await Promise.all([
    entriesPrefetch ? entriesPrefetch.then((r) => r ?? fetchEntries()) : fetchEntries(),
    continuable
      ? api<{ approvals: PendingApproval[] }>(`/api/sessions/${encodeURIComponent(s.id)}/approvals`).catch(() => null)
      : Promise.resolve(null),
  ]);
  window.clearTimeout(skeletonTimer);

  if (tracked) {
    if (sessionsState.openingKey !== opening) return;
    sessionsState.openingKey = null;
  }

  if (!entriesRes) {
    if (tracked) showMainEmpty("Couldn't load this conversation. Check your connection and click it again.");
    renderList();
    return;
  }

  const messages = entriesToMessages(entriesRes.entries ?? [], transcriptModel());
  const earlier = entriesRes.earlierEntries ?? 0;
  const anchorSeq = entriesRes.entries?.[0]?.seq ?? null;
  if (continuable) {
    attachPendingApprovals(messages, approvalsRes?.approvals ?? [], transcriptModel());
    conv.mountContinuable(s.threadRef, s.id, s.scopeId, messages, s.channelName ?? null);
    conv.setTranscriptWindow(anchorSeq, earlier);
  } else {
    conv.mountReadOnly(s, messages, earlier, anchorSeq);
  }
  renderList();
}
