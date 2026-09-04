import { html, nothing, render, type TemplateResult } from "lit";
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Hash,
  ListFilter,
  Lock,
  Plus,
  RefreshCw,
  Search,
  User,
  UserPlus,
  Users,
  X,
  type IconNode,
} from "lucide";
import {
  api,
  isContinuable,
  sharedContextLabel,
  withBase,
  type CoreContext,
  type CoreProject,
  type CoreSession,
} from "./core-bridge";
import { UI_BASE } from "./deep-link";
import { errMessage } from "../../chassis/src/errors";
import { actionSnippet, closeFormMenus, fieldSelect, formatBytes, icon, initials, relTime, toggleFormMenu } from "./ui";
import { appState, replacePanePreservingFocus, switchView, syncUrlFromState } from "./shell";
import { mainConversation } from "./conversations";
import { groupDmTitle, openSession, refreshSessions, sessionsState, slackLogo, surfaceOf } from "./sessions";
import { activityOf } from "./session-list";
import type { WebhookView } from "./webhooks";
import type { CronView } from "./crons";
import { cronRunSummary, cronRunSummaryTitle, cronScheduleSummary } from "./cron-format";
import { restoreDialogFocus } from "./dialog-focus";
import { ambientPolicySection, loadAmbientPolicy, resetAmbientPolicy } from "./ambient-policy";
import { contextModelSection, loadContextModel, resetContextModel } from "./context-model";
import { channelHeaderSection, loadChannelHeader, resetChannelHeader } from "./channel-header";

interface ScopeFile {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  createdAt: number;
  openable: boolean;
}
interface ScopeDeployment {
  id: string;
  name: string;
  status: string;
  permission: "read" | "write";
  currentVersion: number;
}
interface ScopeSkill {
  id: string;
  name: string;
  description: string;
  status: string;
}
interface ScopeResourcesView {
  files: ScopeFile[];
  webhooks: WebhookView[];
  crons: CronView[];
  deployments: ScopeDeployment[];
  skills: ScopeSkill[];
  manageable: boolean;
}

interface DirectoryMatch {
  principalId: string;
  displayName: string;
  type: string;
}

export const contextsState = {
  list: [] as CoreContext[],
  loaded: false,
  loadedAt: 0,
  selected: null as string | null,
  resources: null as ScopeResourcesView | null,
  resourcesScope: null as string | null,
  resourcesLoading: false,
  resourcesNotice: "",
  createOpen: false,
  createName: "",
  createSaving: false,
  createError: "",
  memberProjectId: null as string | null,
  memberQuery: "",
  memberMatches: [] as DirectoryMatch[],
  memberSearching: false,
  memberBusy: false,
  memberError: "",
  memberSearchedQuery: "",
  slackEditing: false,
  slackValue: "",
  slackBusy: false,
  slackError: "",
};

let contextsLoading = false;
let contextsNotice = "";
let memberSearchSeq = 0;
const MEMBER_SEARCH_DEBOUNCE_MS = 300;
let memberSearchTimer: ReturnType<typeof setTimeout> | undefined;

function cancelMemberSearchTimer(): void {
  if (memberSearchTimer !== undefined) {
    clearTimeout(memberSearchTimer);
    memberSearchTimer = undefined;
  }
}
let createProjectOpener: HTMLElement | null = null;
let createProjectSeq = 0;
let contextsResetSeq = 0;
let contextsFetchSeq = 0;
let contextsQuery = "";
let contextsWorkspaceFilter: "active" | "all" = "active";

async function fetchContexts(): Promise<CoreContext[]> {
  const fetchSeq = ++contextsFetchSeq;
  const result = await api<{ contexts: CoreContext[] }>("/api/contexts").catch((error: unknown) => {
    if (fetchSeq !== contextsFetchSeq) return null;
    throw error;
  });
  if (!result || fetchSeq !== contextsFetchSeq) return contextsState.list;
  contextsState.list = result.contexts ?? [];
  contextsState.loaded = true;
  contextsState.loadedAt = Date.now();
  return contextsState.list;
}

export function resetContextsState(): void {
  contextsState.list = [];
  contextsState.loaded = false;
  contextsState.loadedAt = 0;
  contextsState.selected = null;
  contextsState.resources = null;
  contextsState.resourcesScope = null;
  contextsState.resourcesLoading = false;
  contextsState.resourcesNotice = "";
  contextsState.createOpen = false;
  contextsState.createName = "";
  contextsState.createSaving = false;
  contextsState.createError = "";
  contextsState.memberProjectId = null;
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberBusy = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  cancelMemberSearchTimer();
  contextsNotice = "";
  memberSearchSeq++;
  contextsFetchSeq++;
  createProjectSeq++;
  contextsResetSeq++;
  createProjectOpener = null;
  contextsQuery = "";
  contextsWorkspaceFilter = "active";
}

export async function renderContexts(): Promise<void> {
  if (appState.currentView !== "contexts") return;
  const seq = appState.viewRenderSeq;
  contextsNotice = "";
  contextsLoading = true;
  drawContexts();
  try {
    await Promise.all([fetchContexts(), refreshSessions({ silent: true })]);
    if (seq !== appState.viewRenderSeq || appState.currentView !== "contexts") return;
  } catch (e) {
    if (seq !== appState.viewRenderSeq || appState.currentView !== "contexts") return;
    contextsNotice = errMessage(e, "Failed to load contexts.");
  }
  contextsLoading = false;
  if (
    contextsState.selected &&
    contextsState.list.some((c) => c.scopeId === contextsState.selected) &&
    contextsState.resourcesScope !== contextsState.selected
  ) {
    void loadScopeResources(contextsState.selected);
    void loadAmbientPolicy(contextsState.selected, drawContexts);
    void loadContextModel(contextsState.selected, drawContexts);
    void loadChannelHeader(contextsState.selected, drawContexts);
  }
  drawContexts();
}

function contextMeta(c: CoreContext): { title: string; sub: string; glyph: IconNode } {
  if (c.project) {
    const memberCount = projectPeople(c).length;
    return {
      title: c.project.name,
      sub: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
      glyph: Folder,
    };
  }
  if (c.kind === "personal") {
    return { title: "Personal", sub: "Just you — your web chats and DMs with the agent live here.", glyph: User };
  }
  if (c.kind === "group") {
    return {
      title: sharedContextLabel(c.scopeId, c.name) ?? "Group DM",
      sub: "Shared with everyone in this group conversation.",
      glyph: Users,
    };
  }
  return {
    title: sharedContextLabel(c.scopeId, c.name) ?? "Channel",
    sub: "Shared with everyone in this channel.",
    glyph: Hash,
  };
}

export async function ensureContexts(force = false): Promise<CoreContext[]> {
  if (contextsState.loaded && !force) return contextsState.list;
  try {
    await fetchContexts();
  } catch {
    void 0;
  }
  return contextsState.list;
}

export function personalScopeId(): string | null {
  return contextsState.list.find((c) => c.kind === "personal")?.scopeId ?? null;
}

export function resolveProjectScope(contexts: readonly CoreContext[], slug: string): string | null {
  if (slug.startsWith("channel:") || slug.startsWith("group:")) {
    return contexts.some((context) => context.scopeId === slug) ? slug : null;
  }
  const normalized = slug.toLowerCase();
  const matches = contexts.filter((context) => {
    const match = /^personal:([^@]+)@/.exec(context.scopeId);
    return match?.[1]?.toLowerCase() === normalized;
  });
  return matches.length === 1 ? matches[0]!.scopeId : null;
}

function metaForScope(scopeId: string | null, fallbackName?: string | null): { title: string; glyph: IconNode } {
  const c = scopeId ? contextsState.list.find((x) => x.scopeId === scopeId) : undefined;
  if (c) {
    const { title, glyph } = contextMeta(c);
    return { title, glyph };
  }
  const shared = sharedContextLabel(scopeId, fallbackName ?? null);
  if (shared) return { title: shared, glyph: scopeId?.startsWith("group:") ? Users : Hash };
  if (scopeId?.startsWith("personal:") && scopeId !== personalScopeId())
    return { title: "Shared personal space", glyph: User };
  return { title: fallbackName?.trim() || "Personal", glyph: User };
}

export function scopeTitle(scopeId: string | null, fallbackName?: string | null): string {
  return metaForScope(scopeId, fallbackName).title;
}

export function scopeChip(scopeId: string | null, fallbackName?: string | null): TemplateResult {
  const { title, glyph } = metaForScope(scopeId, fallbackName);
  return html`<span class="scope-chip" title=${`In ${title}`}
    >${icon(glyph, 12)}<span>${title.replace(/^#/, "")}</span></span
  >`;
}

export function scopeFilterControl(current: string | null, onSelect: (scopeId: string | null) => void): TemplateResult {
  const label = current ? metaForScope(current).title : "All contexts";
  const option = (scopeId: string | null, text: string, glyph: IconNode) => {
    const active = (current ?? null) === scopeId;
    return html`
      <button
        class="menu-option ${active ? "active" : ""}"
        type="button"
        role="menuitemradio"
        aria-checked=${active ? "true" : "false"}
        @click=${(e: Event) => {
          e.stopPropagation();
          closeFormMenus();
          onSelect(scopeId);
        }}
      >
        <span class="menu-option-label scope-option-label">${icon(glyph, 14)}<span>${text}</span></span>
        ${active ? icon(Check, 15) : nothing}
      </button>
    `;
  };
  return html`
    <div class="menu-control form-menu-control scope-filter">
      <button class="menu-button" type="button" aria-haspopup="menu" aria-expanded="false" @click=${toggleFormMenu}>
        ${icon(ListFilter, 14)}<span class="menu-label">Filter by: ${label}</span>${icon(ChevronDown, 14)}
      </button>
      <div class="menu-popover" role="menu" hidden>
        <div class="menu-title">Filter by context</div>
        ${option(null, "All contexts", Boxes)}
        ${contextsState.list.map((c) => option(c.scopeId, contextMeta(c).title, contextMeta(c).glyph))}
      </div>
    </div>
  `;
}

function sessionsIn(scopeId: string): CoreSession[] {
  return sessionsState.list
    .filter((s) => s.scopeId === scopeId && !s.archived)
    .sort((a, b) => activityOf(b) - activityOf(a));
}

function drawContexts(): void {
  if (appState.currentView !== "contexts" || !appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "pane contexts-pane";
  const selected = contextsState.selected
    ? contextsState.list.find((c) => c.scopeId === contextsState.selected)
    : undefined;
  render(selected ? detailTpl(selected) : gridTpl(), host);
  replacePanePreservingFocus(host);
  const dialog = host.querySelector<HTMLDialogElement>(".project-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function gridTpl(): TemplateResult {
  const status = contextsNotice || (contextsLoading && contextsState.list.length === 0 ? "Loading projects…" : "");
  const q = contextsQuery.trim().toLowerCase();
  const matches = (context: CoreContext) => {
    const meta = contextMeta(context);
    return (
      (!q || `${meta.title} ${meta.sub}`.toLowerCase().includes(q)) &&
      (contextsWorkspaceFilter === "all" ||
        context.kind === "personal" ||
        Boolean(context.project) ||
        Boolean(context.sessionCount))
    );
  };
  const projects = contextsState.list.filter(matches);
  const groupOf = (context: CoreContext) => {
    if (context.kind === "personal") return "personal";
    return context.project ? "web" : "slack";
  };
  const groups = [
    { key: "personal", label: "Personal" },
    { key: "web", label: "Web" },
    { key: "slack", label: "Slack" },
  ]
    .map((g) => ({ ...g, items: projects.filter((context) => groupOf(context) === g.key) }))
    .filter((g) => g.items.length > 0);
  const projectsFiltered = Boolean(q);
  let projectList: TemplateResult | typeof nothing = nothing;
  if (projects.length)
    projectList = html`<div class="project-list">
      ${groups.map(
        (g) =>
          html`<section class="project-group">
            <div class="project-group-head">
              ${g.label} <span class="project-group-count">· ${g.items.length}</span>
            </div>
            ${g.items.map(contextRow)}
          </section>`,
      )}
    </div>`;
  else if (!contextsLoading) {
    projectList = html`<div class="empty compact project-empty">
      ${projectsFiltered ? "No projects match your search." : "No projects yet."}
    </div>`;
  }
  return html`
    <div class="project-grid-content">
      <div class="pane-head">
        <h1 class="pane-title">Projects</h1>
        <div class="project-head-actions">
          <button
            class="pane-refresh"
            type="button"
            aria-label="Refresh projects"
            title="Refresh projects"
            @click=${() => void renderContexts()}
          >
            ${icon(RefreshCw, 17)}
          </button>
          <button
            class="btn primary project-create-button"
            type="button"
            aria-label="New project"
            title="New project"
            @click=${openCreateProject}
          >
            ${icon(FolderPlus, 15)}<span>New project</span>
          </button>
        </div>
      </div>
      <div class="list-toolbar project-toolbar">
        <label class="list-search"
          ><span class="sr-only">Search projects</span
          ><input
            data-focus-key="contexts-search"
            type="search"
            aria-label="Search projects"
            placeholder="Search projects…"
            .value=${contextsQuery}
            @input=${(event: InputEvent) => {
              contextsQuery = (event.currentTarget as HTMLInputElement).value;
              drawContexts();
            }}
        /></label>
        <label class="list-select"
          ><span>Show</span>${fieldSelect({
            compact: true,
            value: contextsWorkspaceFilter,
            onChange: (value) => {
              contextsWorkspaceFilter = value as typeof contextsWorkspaceFilter;
              drawContexts();
            },
            options: [html`<option value="active">Active only</option>`, html`<option value="all">Everything</option>`],
          })}</label
        >
      </div>
      ${status ? html`<div class="status">${status}</div>` : nothing} ${projectList}
    </div>
    ${createProjectDialog()}
  `;
}

function contextRow(c: CoreContext): TemplateResult {
  const { title, sub, glyph } = contextMeta(c);
  const count = c.sessionCount === 1 ? "1 conversation" : `${c.sessionCount} conversations`;
  const meta = [c.project ? sub : "", count, c.lastActivityAt ? `active ${relTime(c.lastActivityAt)}` : ""]
    .filter(Boolean)
    .join(" · ");
  return html`
    <button class="context-row" type="button" title=${sub} @click=${() => selectContext(c.scopeId)}>
      <span class="context-glyph">${icon(glyph, 15)}</span>
      <span class="context-row-title">${title}</span>
      ${c.isPrivate ? html`<span class="context-lock" title="Private channel">${icon(Lock, 12)}</span>` : nothing}
      <span class="context-row-meta">${meta}</span>
    </button>
  `;
}

function detailTpl(c: CoreContext): TemplateResult {
  const { title, sub, glyph } = contextMeta(c);
  const sessions = sessionsIn(c.scopeId);
  const completelyEmpty = sessions.length === 0 && scopeResourcesEmpty(c.scopeId);
  return html`
    <div class="context-detail">
      <button class="context-back" type="button" @click=${() => selectContext(null)}>
        ${icon(ArrowLeft, 15)}<span>Projects</span>
      </button>
      <div class="context-detail-head">
        <span class="context-glyph large">${icon(glyph, 22)}</span>
        <div class="context-detail-titles">
          <h1 class="pane-title">
            ${title}
            ${c.isPrivate ? html`<span class="context-lock" title="Private channel">${icon(Lock, 14)}</span>` : nothing}
          </h1>
          <div class="context-sub">
            ${c.project ? sub : `${sub} The agent's files and memory here are separate from your other contexts.`}
          </div>
        </div>
        <div class="context-detail-actions">
          ${
            c.project
              ? html`<button class="btn context-add-member" type="button" @click=${() => toggleMemberPicker(c)}>
                  ${icon(UserPlus, 15)}<span>Add people</span>
                </button>`
              : nothing
          }
          <button class="btn primary context-new-chat" type="button" @click=${() => startChatIn(c)}>
            ${icon(Plus, 15)}<span>New chat</span>
          </button>
        </div>
      </div>
      <div class="context-workspace has-settings">
        <div class="context-workspace-main">
          ${
            completelyEmpty
              ? html`
                  <section class="context-panel context-project-empty">
                    <span class="context-glyph large" aria-hidden="true">${icon(glyph, 22)}</span>
                    <h2>This project is ready for work</h2>
                    <p>
                      Start a conversation with New chat. Files, automations, and other work created there will stay
                      scoped to this project.
                    </p>
                  </section>
                `
              : html`
                  <section class="context-panel context-conversations" aria-labelledby="context-conversations-title">
                    <div class="context-panel-heading">
                      <h2 class="context-panel-title" id="context-conversations-title">Conversations</h2>
                      ${sessions.length ? html`<span class="context-panel-count">${sessions.length}</span>` : nothing}
                    </div>
                    ${
                      sessions.length
                        ? html`<div class="context-session-list">${sessions.map((s) => contextSessionRow(s))}</div>`
                        : html`<div class="context-inline-empty">No conversations yet.</div>`
                    }
                  </section>
                  ${resourceSections(c.scopeId)}
                `
          }
        </div>
        <aside class="context-settings" aria-label=${c.project ? "Project settings" : "Context settings"}>
          ${c.project ? projectMembersSection(c) : nothing} ${c.project ? projectSlackSection(c) : nothing}
          ${contextModelSection(c.scopeId)} ${channelHeaderSection(c.scopeId)} ${ambientPolicySection(c.scopeId)}
        </aside>
      </div>
    </div>
  `;
}

function scopeResourcesEmpty(scopeId: string): boolean {
  const r = contextsState.resourcesScope === scopeId ? contextsState.resources : null;
  return Boolean(
    r &&
    r.files.length === 0 &&
    r.webhooks.length === 0 &&
    r.crons.length === 0 &&
    r.deployments.length === 0 &&
    r.skills.length === 0,
  );
}

function projectPeople(context: CoreContext): string[] {
  if (!context.project) return [];
  return [...new Set([context.project.ownerId, ...context.project.memberIds].filter(Boolean))];
}

function isProjectOwner(context: CoreContext): boolean {
  return context.project?.ownerId === appState.me?.user;
}

function memberLabel(context: CoreContext, principalId: string): string {
  if (principalId === appState.me?.user) return "You";
  return context.project?.members.find((member) => member.principalId === principalId)?.displayName || principalId;
}

function channelNameOptions(): string[] {
  return [
    ...new Set(
      contextsState.list
        .filter((c) => c.kind === "channel" && c.name)
        .map((c) => c.name!.replace(/^#/, ""))
        .sort(),
    ),
  ];
}

async function linkProjectSlackChannel(context: CoreContext): Promise<void> {
  const channel = contextsState.slackValue.trim().replace(/^#/, "");
  if (!context.project || contextsState.slackBusy || !channel) return;
  const resetSeq = contextsResetSeq;
  contextsState.slackBusy = true;
  contextsState.slackError = "";
  drawContexts();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(context.project.id)}/slack-channel`, {
      method: "PUT",
      body: JSON.stringify({ channel }),
    });
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("Core returned an invalid project");
    upsertProject(project);
    contextsState.slackEditing = false;
    contextsState.slackValue = "";
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.slackError = errMessage(error, "Couldn't link that channel — you must be a member of it.");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.slackBusy = false;
      drawContexts();
    }
  }
}

async function unlinkProjectSlackChannel(context: CoreContext): Promise<void> {
  const linked = context.project?.slackChannel;
  if (!context.project || !linked || contextsState.slackBusy) return;
  if (!window.confirm(`Unlink #${linked.channelName} from ${context.name || "this project"}?`)) return;
  const resetSeq = contextsResetSeq;
  contextsState.slackBusy = true;
  contextsState.slackError = "";
  drawContexts();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(context.project.id)}/slack-channel`, {
      method: "DELETE",
    });
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("Core returned an invalid project");
    upsertProject(project);
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.slackError = errMessage(error, "Couldn't unlink the channel.");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.slackBusy = false;
      drawContexts();
    }
  }
}

function projectSlackLinked(context: CoreContext): TemplateResult {
  const linked = context.project!.slackChannel!;
  return html`
    <div class="project-member-row">
      <span class="context-glyph" aria-hidden="true">${icon(Hash, 15)}</span>
      <span class="project-member-name">${linked.channelName}</span>
      <button
        class="project-icon-button danger"
        type="button"
        aria-label=${`Unlink #${linked.channelName}`}
        title=${`Unlink #${linked.channelName}`}
        ?disabled=${contextsState.slackBusy}
        @click=${() => void unlinkProjectSlackChannel(context)}
      >
        ${icon(X, 15)}
      </button>
    </div>
    <p class="context-hint">
      The agent posts this project's updates to #${linked.channelName}, and everyone in the channel is in the project.
    </p>
  `;
}

function projectSlackEditor(context: CoreContext): TemplateResult {
  const options = channelNameOptions();
  return html`
    <form
      class="project-slack-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        void linkProjectSlackChannel(context);
      }}
    >
      <div class="project-member-search-row">
        ${icon(Hash, 16)}
        <input
          type="text"
          data-focus-key="project-slack-channel"
          autocomplete="off"
          maxlength="200"
          placeholder="channel name"
          list="project-slack-channels"
          aria-label="Slack channel to link"
          .value=${contextsState.slackValue}
          ?disabled=${contextsState.slackBusy}
          @input=${(e: Event) => {
            contextsState.slackValue = (e.target as HTMLInputElement).value;
          }}
        />
      </div>
      <datalist id="project-slack-channels">${options.map((name) => html`<option value=${name}></option>`)}</datalist>
      <div class="project-slack-actions">
        <button class="btn primary" type="submit" ?disabled=${contextsState.slackBusy}>Link</button>
        <button
          class="btn"
          type="button"
          ?disabled=${contextsState.slackBusy}
          @click=${() => {
            contextsState.slackEditing = false;
            contextsState.slackValue = "";
            contextsState.slackError = "";
            drawContexts();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  `;
}

function projectSlackIdle(): TemplateResult {
  return html`
    <button
      class="btn project-slack-link"
      type="button"
      ?disabled=${contextsState.slackBusy}
      @click=${() => {
        contextsState.slackEditing = true;
        contextsState.slackError = "";
        drawContexts();
      }}
    >
      ${icon(Hash, 15)}<span>Link a channel</span>
    </button>
    <p class="context-hint">
      Give this project a home channel on Slack — the agent will post updates there, and everyone in the channel joins
      the project.
    </p>
  `;
}

function projectSlackSection(context: CoreContext): TemplateResult {
  const project = context.project!;
  let body: TemplateResult;
  if (project.slackChannel) body = projectSlackLinked(context);
  else if (contextsState.slackEditing) body = projectSlackEditor(context);
  else body = projectSlackIdle();
  return html`
    <section class="context-panel project-slack" aria-labelledby="project-slack-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-slack-title">Slack channel</h2>
      </div>
      ${body}
      ${contextsState.slackError ? html`<div class="project-member-status error" aria-live="polite">${contextsState.slackError}</div>` : nothing}
    </section>
  `;
}

function projectMembersSection(context: CoreContext): TemplateResult {
  const project = context.project!;
  const pickerOpen = contextsState.memberProjectId === project.id;
  return html`
    <section class="context-panel project-members" aria-labelledby="project-people-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-people-title">People</h2>
        <span class="context-panel-count">${projectPeople(context).length}</span>
      </div>
      <div class="project-member-list">
        ${projectPeople(context).map((principalId) => {
          const label = memberLabel(context, principalId);
          const viaChannel = Boolean(project.members.find((member) => member.principalId === principalId)?.viaChannel);
          return html`
            <div class="project-member-row">
              <span class="project-member-avatar" aria-hidden="true">${initials(label)}</span>
              <span class="project-member-name">${label}</span>
              ${principalId === project.ownerId ? html`<span class="badge">Owner</span>` : nothing}
              ${
                viaChannel && project.slackChannel
                  ? html`<span class="badge" title="Joined via the linked Slack channel"
                      >#${project.slackChannel.channelName}</span
                    >`
                  : nothing
              }
              ${
                isProjectOwner(context) && principalId !== project.ownerId && !viaChannel
                  ? html`<button
                      class="project-icon-button danger"
                      type="button"
                      aria-label=${`Remove ${label}`}
                      title=${`Remove ${label}`}
                      ?disabled=${contextsState.memberSearching || contextsState.memberBusy}
                      @click=${() => void removeProjectMember(context, principalId)}
                    >
                      ${icon(X, 15)}
                    </button>`
                  : nothing
              }
            </div>
          `;
        })}
      </div>
      ${pickerOpen ? memberPicker(context) : nothing}
      ${contextsState.memberError ? html`<div class="project-member-status error" aria-live="polite">${contextsState.memberError}</div>` : nothing}
    </section>
  `;
}

function memberPicker(context: CoreContext): TemplateResult {
  const members = new Set(projectPeople(context));
  const matches = contextsState.memberMatches.filter((match) => !members.has(match.principalId)).slice(0, 8);
  const idle = !contextsState.memberSearching && !contextsState.memberBusy && !contextsState.memberError;
  let emptyNote = "";
  if (idle && contextsState.memberSearchedQuery && matches.length === 0) {
    emptyNote = contextsState.memberMatches.length
      ? "Everyone matching is already in this project."
      : `No matches for “${contextsState.memberSearchedQuery}”.`;
  }
  let memberStatus = emptyNote;
  if (contextsState.memberSearching) memberStatus = "Searching…";
  else if (contextsState.memberBusy) memberStatus = "Working…";
  return html`
    <form class="project-member-picker" @submit=${(event: SubmitEvent) => void searchProjectMembers(event, context)}>
      <label for="project-member-search">Add people</label>
      <div class="project-member-search-row">
        ${icon(Search, 16)}
        <input
          id="project-member-search"
          data-focus-key="project-member-search"
          name="query"
          type="search"
          autocomplete="off"
          maxlength="80"
          placeholder="Search by name or handle"
          .value=${contextsState.memberQuery}
          ?disabled=${contextsState.memberBusy}
          @input=${(event: InputEvent) => {
            contextsState.memberQuery = (event.currentTarget as HTMLInputElement).value;
            scheduleMemberSearch(context);
          }}
        />
        <button
          class="project-icon-button"
          type="submit"
          aria-label="Search"
          title="Search"
          ?disabled=${contextsState.memberSearching || contextsState.memberBusy}
        >
          ${icon(Search, 15)}
        </button>
        <button
          class="project-icon-button"
          type="button"
          aria-label="Close"
          title="Close"
          ?disabled=${contextsState.memberBusy}
          @click=${closeMemberPicker}
        >
          ${icon(X, 15)}
        </button>
      </div>
      <div class="project-member-results">
        ${matches.map(
          (match) => html`
            <button
              class="project-member-result"
              type="button"
              ?disabled=${contextsState.memberSearching || contextsState.memberBusy}
              @click=${() => void addProjectMember(context, match)}
            >
              <span class="project-member-avatar" aria-hidden="true">${initials(match.displayName)}</span>
              <span class="project-member-name">${match.displayName}</span>
              ${icon(Plus, 15)}
            </button>
          `,
        )}
      </div>
      <div class="project-member-status" aria-live="polite">${memberStatus}</div>
    </form>
  `;
}

function resourceSections(scopeId: string): TemplateResult | typeof nothing {
  if (contextsState.resourcesScope !== scopeId) return html``;
  if (contextsState.resourcesNotice) return html`<div class="status">${contextsState.resourcesNotice}</div>`;
  const r = contextsState.resources;
  if (!r) {
    return contextsState.resourcesLoading
      ? html`<div class="empty compact">Loading this context's files, webhooks, crons, apps and skills…</div>`
      : html``;
  }
  if (
    r.files.length === 0 &&
    r.webhooks.length === 0 &&
    r.crons.length === 0 &&
    r.deployments.length === 0 &&
    r.skills.length === 0
  ) {
    return nothing;
  }
  const manage = r.manageable;
  return html`
    ${r.files.length ? resourceGroup("Files", r.files.map(fileRow)) : nothing}
    ${
      r.skills.length
        ? resourceGroup(
            "Skills",
            r.skills.map((s) => skillRow(s, manage)),
          )
        : nothing
    }
    ${
      r.crons.length
        ? resourceGroup(
            "Crons",
            r.crons.map((c) => cronRow(c, manage)),
          )
        : nothing
    }
    ${r.webhooks.length ? resourceGroup("Webhooks", r.webhooks.map(webhookRow)) : nothing}
    ${r.deployments.length ? resourceGroup("Apps", r.deployments.map(deploymentRow)) : nothing}
  `;
}

const resourceBusy = new Set<string>();

async function manageCron(id: string, action: "enable" | "disable" | "delete"): Promise<void> {
  const key = `cron:${id}`;
  if (resourceBusy.has(key)) return;
  if (action === "delete" && !confirm("Delete this cron? This can't be undone.")) return;
  resourceBusy.add(key);
  drawContexts();
  try {
    if (action === "delete") await api(`/api/crons/${encodeURIComponent(id)}`, { method: "DELETE" });
    else await api(`/api/crons/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    const scope = contextsState.resourcesScope;
    if (scope) await loadScopeResources(scope);
  } catch (e) {
    contextsState.resourcesNotice = errMessage(e, "Couldn't update that cron.");
  } finally {
    resourceBusy.delete(key);
    drawContexts();
  }
}

async function deleteScopeSkill(id: string): Promise<void> {
  const key = `skill:${id}`;
  if (resourceBusy.has(key)) return;
  if (!confirm("Delete this skill? This can't be undone.")) return;
  resourceBusy.add(key);
  drawContexts();
  try {
    await api(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
    const scope = contextsState.resourcesScope;
    if (scope) await loadScopeResources(scope);
  } catch (e) {
    contextsState.resourcesNotice = errMessage(e, "Couldn't delete that skill.");
  } finally {
    resourceBusy.delete(key);
    drawContexts();
  }
}

function resourceGroup(label: string, rows: TemplateResult[]): TemplateResult {
  const view = label === "Apps" ? "deploys" : label.toLowerCase();
  const scope = contextsState.resourcesScope;
  const supportsScopeLink = view === "files" || view === "deploys";
  const href = `${UI_BASE}/${encodeURIComponent(view)}${scope && supportsScopeLink ? `?scope=${encodeURIComponent(scope)}` : ""}`;
  return html`
    <section class="context-panel context-resource-group">
      <div class="context-panel-heading context-resource-heading">
        <h2 class="context-panel-title">${label}</h2>
        <a href=${href}>View all</a>
      </div>
      <div class="context-session-list">${rows}</div>
    </section>
  `;
}

function fileRow(f: ScopeFile): TemplateResult {
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title">${f.name}</span>
      <span class="context-session-meta">
        <span>${formatBytes(f.sizeBytes)}</span>
        <span>${relTime(f.createdAt)}</span>
        ${
          f.openable
            ? html`<a
                class="context-resource-link"
                href=${withBase(`/api/files/${encodeURIComponent(f.id)}/content`)}
                target="_blank"
                rel="noreferrer"
                >Open</a
              >`
            : nothing
        }
      </span>
    </div>
  `;
}

function webhookRow(w: WebhookView): TemplateResult {
  let lastRun = "never fired";
  if (w.lastError) lastRun = "error";
  else if (w.lastFiredAt) lastRun = relTime(w.lastFiredAt);
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title">${actionSnippet(w.action)}</span>
      <span class="context-session-meta">
        <span class="badge">${w.verification.scheme}</span>
        <span class="badge">${w.enabled ? "enabled" : "disabled"}</span>
        <span>${lastRun}</span>
      </span>
    </div>
  `;
}

function cronRow(c: CronView, manage = false): TemplateResult {
  let status = "disabled";
  if (c.archived) status = "archived";
  else if (c.enabled) status = "enabled";
  const busy = resourceBusy.has(`cron:${c.id}`);
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title">${c.title ?? actionSnippet(c.message ?? c.action ?? "")}</span>
      <span class="context-session-meta">
        <span class="badge">${cronScheduleSummary(c)}</span>
        <span class="badge">${status}</span>
        <span title=${cronRunSummaryTitle(c)}>${cronRunSummary(c)}</span>
        ${
          manage && !c.archived
            ? html`
                <button
                  class="context-resource-action"
                  type="button"
                  ?disabled=${busy}
                  @click=${() => void manageCron(c.id, c.enabled ? "disable" : "enable")}
                >
                  ${c.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  class="context-resource-action danger"
                  type="button"
                  ?disabled=${busy}
                  @click=${() => void manageCron(c.id, "delete")}
                >
                  Delete
                </button>
              `
            : nothing
        }
      </span>
    </div>
  `;
}

function skillRow(s: ScopeSkill, manage = false): TemplateResult {
  const busy = resourceBusy.has(`skill:${s.id}`);
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title">${s.name}</span>
      <span class="context-session-meta">
        ${s.description ? html`<span class="context-resource-desc">${s.description}</span>` : nothing}
        <span class="badge">${s.status}</span>
        ${
          manage
            ? html`<button
                class="context-resource-action danger"
                type="button"
                ?disabled=${busy}
                @click=${() => void deleteScopeSkill(s.id)}
              >
                Delete
              </button>`
            : nothing
        }
      </span>
    </div>
  `;
}

function deploymentRow(d: ScopeDeployment): TemplateResult {
  return html`
    <div class="context-session-row context-resource-row">
      <span class="context-session-title">${d.name}</span>
      <span class="context-session-meta">
        <span class="badge">v${d.currentVersion}</span>
        <span class="badge">${d.status}</span>
        <span class="badge">${d.permission === "write" ? "manage" : "read"}</span>
      </span>
    </div>
  `;
}

function openCreateProject(): void {
  createProjectOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  contextsState.createOpen = true;
  contextsState.createName = "";
  contextsState.createError = "";
  drawContexts();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
}

function closeCreateProject(): void {
  createProjectSeq++;
  contextsState.createOpen = false;
  contextsState.createSaving = false;
  contextsState.createName = "";
  contextsState.createError = "";
  drawContexts();
  queueMicrotask(() => {
    const target = createProjectOpener;
    createProjectOpener = null;
    restoreDialogFocus(target, () => document.querySelector<HTMLElement>(".project-create-button"));
  });
}

function createProjectDialog(): TemplateResult | typeof nothing {
  if (!contextsState.createOpen) return nothing;
  return html`
    <dialog
      class="project-dialog"
      aria-labelledby="project-dialog-title"
      @close=${closeCreateProject}
      @click=${(event: MouseEvent) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <form @submit=${(event: SubmitEvent) => void createProject(event)}>
        <div class="project-dialog-head">
          <span class="context-glyph large">${icon(FolderPlus, 21)}</span>
          <div><h2 id="project-dialog-title">New project</h2></div>
          <button
            class="project-icon-button"
            type="button"
            aria-label="Close new project"
            title="Close"
            @click=${closeCreateProject}
          >
            ${icon(X, 16)}
          </button>
        </div>
        <label class="project-name-field" for="project-name">
          <span>Name</span>
          <input
            id="project-name"
            data-focus-key="project-name"
            name="name"
            maxlength="200"
            autocomplete="off"
            placeholder="launch cohort"
            .value=${contextsState.createName}
            ?disabled=${contextsState.createSaving}
            @input=${(event: InputEvent) => {
              contextsState.createName = (event.currentTarget as HTMLInputElement).value;
              contextsState.createError = "";
            }}
          />
        </label>
        <div class="form-error" aria-live="polite">${contextsState.createError}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closeCreateProject}>
            ${contextsState.createSaving ? "Close" : "Cancel"}
          </button>
          <button class="btn primary" type="submit" ?disabled=${contextsState.createSaving}>
            ${icon(FolderPlus, 15)}<span>${contextsState.createSaving ? "Creating…" : "Create project"}</span>
          </button>
        </div>
      </form>
    </dialog>
  `;
}

export function openProjectDetail(scopeId: string): void {
  switchView("contexts");
  selectContext(scopeId);
}

export async function renameProject(project: CoreProject, name: string): Promise<boolean> {
  try {
    const updated = projectFromResponse(
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    );
    if (!updated) return false;
    upsertProject(updated);
    if (appState.currentView === "contexts") drawContexts();
    return true;
  } catch {
    return false;
  }
}

function projectFromResponse(response: unknown): CoreProject | null {
  const project = (response as { project?: CoreProject } | null)?.project;
  if (
    !project ||
    !project.id ||
    !project.name ||
    !project.ownerId ||
    !project.scopeId?.trim() ||
    !Array.isArray(project.memberIds) ||
    !Array.isArray(project.members) ||
    project.members.some((member) => !member?.principalId || !member.displayName)
  )
    return null;
  return project;
}

function upsertProject(project: CoreProject): CoreContext {
  const loaded = contextsState.loaded;
  contextsFetchSeq++;
  const scopeId = project.scopeId;
  const current = contextsState.list.find((context) => context.scopeId === scopeId);
  const next: CoreContext = {
    ...current,
    scopeId,
    kind: "group",
    name: project.name,
    sessionCount: current?.sessionCount ?? 0,
    lastActivityAt: current?.lastActivityAt ?? null,
    project,
  };
  contextsState.list = [next, ...contextsState.list.filter((context) => context.scopeId !== scopeId)];
  contextsState.loaded = loaded;
  if (loaded) contextsState.loadedAt = Date.now();
  return next;
}

async function createProject(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (contextsState.createSaving) return;
  const name = contextsState.createName.trim();
  if (!name) {
    contextsState.createError = "Enter a project name.";
    drawContexts();
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
    return;
  }
  const seq = ++createProjectSeq;
  const resetSeq = contextsResetSeq;
  contextsState.createSaving = true;
  drawContexts();
  try {
    const project = projectFromResponse(await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) }));
    if (resetSeq !== contextsResetSeq) return;
    if (!project) throw new Error("Core returned an invalid project");
    const loaded = contextsState.loaded;
    let context = upsertProject(project);
    if (!loaded) {
      await fetchContexts().catch(() => contextsState.list);
      if (resetSeq !== contextsResetSeq) return;
      context = upsertProject(project);
    }
    if (seq !== createProjectSeq) {
      if (appState.currentView === "contexts") drawContexts();
      return;
    }
    contextsState.createOpen = false;
    contextsState.createSaving = false;
    contextsState.createName = "";
    selectContext(context.scopeId);
  } catch (error) {
    if (seq !== createProjectSeq || resetSeq !== contextsResetSeq) return;
    contextsState.createSaving = false;
    contextsState.createError = errMessage(error, "Couldn't create that project.");
    drawContexts();
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
  }
}

function toggleMemberPicker(context: CoreContext): void {
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberProjectId =
    contextsState.memberProjectId === context.project?.id ? null : (context.project?.id ?? null);
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  drawContexts();
  if (contextsState.memberProjectId)
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-member-search")?.focus());
}

function closeMemberPicker(): void {
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberProjectId = null;
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  drawContexts();
}

function scheduleMemberSearch(context: CoreContext): void {
  cancelMemberSearchTimer();
  memberSearchSeq++;
  const hadVisibleState =
    contextsState.memberSearching || contextsState.memberError !== "" || contextsState.memberSearchedQuery !== "";
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  const query = contextsState.memberQuery.trim();
  if (query.length < 2) {
    if (hadVisibleState || contextsState.memberMatches.length) {
      contextsState.memberMatches = [];
      drawContexts();
    }
    return;
  }
  memberSearchTimer = setTimeout(() => {
    memberSearchTimer = undefined;
    void runMemberSearch(context, query);
  }, MEMBER_SEARCH_DEBOUNCE_MS);
  if (hadVisibleState) drawContexts();
}

async function searchProjectMembers(event: SubmitEvent, context: CoreContext): Promise<void> {
  event.preventDefault();
  if (!context.project || contextsState.memberBusy) return;
  cancelMemberSearchTimer();
  const input = (event.currentTarget as HTMLFormElement).elements.namedItem("query") as HTMLInputElement | null;
  const query = input?.value.trim() ?? "";
  contextsState.memberQuery = query;
  contextsState.memberError = "";
  if (query.length < 2) {
    contextsState.memberMatches = [];
    contextsState.memberSearchedQuery = "";
    contextsState.memberError = "Enter at least two characters.";
    drawContexts();
    return;
  }
  await runMemberSearch(context, query);
}

async function runMemberSearch(context: CoreContext, query: string): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  if (contextsState.memberProjectId !== context.project.id) return;
  const projectId = context.project.id;
  const searchSeq = ++memberSearchSeq;
  contextsState.memberSearching = true;
  drawContexts();
  try {
    const response = await api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${encodeURIComponent(query)}`);
    if (searchSeq !== memberSearchSeq || contextsState.memberProjectId !== projectId) return;
    contextsState.memberMatches = (response.matches ?? []).filter((match) => match.type === "internal");
    contextsState.memberSearchedQuery = query;
  } catch (error) {
    if (searchSeq !== memberSearchSeq || contextsState.memberProjectId !== projectId) return;
    contextsState.memberSearchedQuery = "";
    contextsState.memberError = errMessage(error, "Couldn't search for people.");
  } finally {
    if (searchSeq === memberSearchSeq) {
      contextsState.memberSearching = false;
      drawContexts();
    }
  }
}

async function addProjectMember(context: CoreContext, member: DirectoryMatch): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  const resetSeq = contextsResetSeq;
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberSearching = false;
  contextsState.memberBusy = true;
  contextsState.memberError = "";
  drawContexts();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(context.project.id)}/members`, {
      method: "POST",
      body: JSON.stringify({ memberId: member.principalId }),
    });
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("Core returned an invalid project");
    upsertProject(project);
    contextsState.memberQuery = "";
    contextsState.memberMatches = [];
    contextsState.memberSearchedQuery = "";
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.memberError = errMessage(error, "Couldn't add that person.");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.memberBusy = false;
      drawContexts();
    }
  }
}

async function removeProjectMember(context: CoreContext, principalId: string): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  const label = memberLabel(context, principalId);
  if (!window.confirm(`Remove ${label} from ${context.name || "this project"}?`)) return;
  const resetSeq = contextsResetSeq;
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberSearching = false;
  contextsState.memberBusy = true;
  contextsState.memberError = "";
  drawContexts();
  try {
    const response = await api(
      `/api/projects/${encodeURIComponent(context.project.id)}/members/${encodeURIComponent(principalId)}`,
      { method: "DELETE" },
    );
    if (resetSeq !== contextsResetSeq) return;
    const project = projectFromResponse(response);
    if (!project) throw new Error("Core returned an invalid project");
    upsertProject(project);
  } catch (error) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState.memberError = errMessage(error, "Couldn't remove that person.");
  } finally {
    if (resetSeq === contextsResetSeq) {
      contextsState.memberBusy = false;
      drawContexts();
    }
  }
}

async function loadScopeResources(scopeId: string): Promise<void> {
  contextsState.resources = null;
  contextsState.resourcesScope = scopeId;
  contextsState.resourcesLoading = true;
  contextsState.resourcesNotice = "";
  drawContexts();
  const seq = appState.viewRenderSeq;
  const stale = () =>
    seq !== appState.viewRenderSeq || appState.currentView !== "contexts" || contextsState.selected !== scopeId;
  try {
    const r = await api<ScopeResourcesView>(`/api/scope-resources?scope=${encodeURIComponent(scopeId)}`);
    if (stale()) return;
    contextsState.resources = {
      files: r.files ?? [],
      webhooks: r.webhooks ?? [],
      crons: r.crons ?? [],
      deployments: r.deployments ?? [],
      skills: r.skills ?? [],
      manageable: r.manageable === true,
    };
  } catch (e) {
    if (stale()) return;
    contextsState.resourcesNotice = errMessage(e, "Failed to load this context's resources.");
  } finally {
    if (!stale()) {
      contextsState.resourcesLoading = false;
      drawContexts();
    }
  }
}

function contextSessionRow(s: CoreSession): TemplateResult {
  const surface = surfaceOf(s);
  const readOnly = !isContinuable(s, appState.me?.user ?? "");
  return html`
    <button class="context-session-row" type="button" @click=${() => void openFromContext(s)}>
      <span class="context-session-title">${groupDmTitle(s)}</span>
      <span class="context-session-meta">
        ${surface === "slack" ? html`<span class="surface surface-slack">${slackLogo(13)}</span>` : html`<span class="badge">${surface}</span>`}
        ${readOnly ? html`<span class="ro-lock" title="Read-only — replies happen on the original surface">${icon(Lock, 12)}</span>` : nothing}
        <span>${relTime(activityOf(s))}</span>
      </span>
    </button>
  `;
}

function selectContext(scopeId: string | null): void {
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberProjectId = null;
  contextsState.memberQuery = "";
  contextsState.memberMatches = [];
  contextsState.memberSearching = false;
  contextsState.memberError = "";
  contextsState.memberSearchedQuery = "";
  contextsState.slackEditing = false;
  contextsState.slackValue = "";
  contextsState.slackBusy = false;
  contextsState.slackError = "";
  contextsState.selected = scopeId;
  contextsState.resources = null;
  contextsState.resourcesScope = null;
  contextsState.resourcesNotice = "";
  contextsState.resourcesLoading = false;
  resetAmbientPolicy();
  resetContextModel();
  resetChannelHeader();
  syncUrlFromState();
  drawContexts();
  if (scopeId) {
    void loadScopeResources(scopeId);
    void loadAmbientPolicy(scopeId, drawContexts);
    void loadContextModel(scopeId, drawContexts);
    void loadChannelHeader(scopeId, drawContexts);
  }
}

function startChatIn(c: CoreContext): void {
  mainConversation().newChat(c.kind === "personal" ? undefined : { scopeId: c.scopeId, name: c.name });
}

async function openFromContext(s: CoreSession): Promise<void> {
  await openSession(s);
}
