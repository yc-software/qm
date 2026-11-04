import { html, nothing, type TemplateResult } from "lit";
import { ArrowUpLeft, Box, Brain, Clock3, Ellipsis, Files, GitFork, KeyRound, Rocket } from "lucide";
import { api } from "./core-bridge";
import { closeFormMenus, toggleFormMenu } from "./ui";
import { icon } from "./icons";
import { tip } from "./tooltip";

/** A session's context carried into the crons/files/memory views so the whole
 * view stays scoped to that project and keeps the session top bar. */
export interface ScopedSessionInfo {
  scopeId: string;
  sessionId: string | null;
  threadRef: string | null;
  title: string;
  crumb: string | null;
}

export const scopedSession: { active: ScopedSessionInfo | null } = { active: null };

export function setScopedSession(info: ScopedSessionInfo | null): void {
  scopedSession.active = info;
}

interface CronLite {
  id: string;
  ownerScopeId: string;
  enabled: boolean;
  archived?: boolean;
}

const toolCountCache = new Map<string, { count: number; at: number }>();
const toolCountInFlight = new Set<string>();

interface CronList {
  crons?: CronLite[];
  visible?: CronLite[];
}

let cronList: { list: CronList; at: number } | null = null;
let cronListLoad: Promise<CronList> | null = null;

export function loadCronList(): Promise<CronList> {
  cronListLoad ??= api<CronList>("/api/crons")
    .finally(() => (cronListLoad = null))
    .then(
      (list) => (cronList = { list, at: Date.now() }).list,
      (error: unknown) => {
        cronList = { list: cronList?.list ?? {}, at: Date.now() };
        throw error;
      },
    );
  return cronListLoad;
}

export function expireCronList(): void {
  if (cronList) cronList.at = 0;
}

function activeCronCount(scope: string): number | null {
  if (!cronList) return null;
  const { crons = [], visible = [] } = cronList.list;
  return new Set(
    [...crons, ...visible].filter((c) => c.ownerScopeId === scope && c.enabled && !c.archived).map((c) => c.id),
  ).size;
}

const TOOL_COUNTERS: Partial<Record<SessionTool, (scope: string) => Promise<number>>> = {
  apps: async (scope) => {
    const r = await api<{ deployments?: Array<{ status?: string; ownerScopeId?: string; createdInScope?: string }> }>(
      "/api/deployments",
    );
    return (r.deployments ?? []).filter(
      (d) => d.status !== "archived" && (d.createdInScope === scope || d.ownerScopeId === scope),
    ).length;
  },
};

/** Cached count of a tool's items in a scope; kicks off a refresh and calls
 * onReady when a fresh count lands. Tools without a counter return null. */
export function scopeToolCount(tool: SessionTool, scope: string, onReady: () => void): number | null {
  if (!scope) return null;
  if (tool === "crons") {
    if ((!cronList || Date.now() - cronList.at >= 60_000) && !toolCountInFlight.has("crons")) {
      toolCountInFlight.add("crons");
      void loadCronList()
        .catch(() => undefined)
        .finally(() => {
          toolCountInFlight.delete("crons");
          onReady();
        });
    }
    return activeCronCount(scope);
  }
  const counter = TOOL_COUNTERS[tool];
  if (!counter) return null;
  const key = `${tool}:${scope}`;
  const hit = toolCountCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.count;
  if (!toolCountInFlight.has(key)) {
    toolCountInFlight.add(key);
    void counter(scope)
      .then((count) => toolCountCache.set(key, { count, at: Date.now() }))
      .catch(() => toolCountCache.set(key, { count: hit?.count ?? 0, at: Date.now() }))
      .finally(() => {
        toolCountInFlight.delete(key);
        onReady();
      });
  }
  return hit?.count ?? null;
}

export type SessionTool = "crons" | "files" | "memory" | "apps" | "skills" | "keychain";

export interface SessionTopbarOpts {
  sessionId?: string | null;
  crumb: string | null;
  title: string;
  activeTool?: SessionTool | null;
  toolCount?: ((tool: SessionTool) => number | null) | null;
  parent?: { title: string; onClick: () => void } | null;
  fork?: { title: string; onClick?: (() => void) | null } | null;
  onTitle?: (() => void) | null;
  onCrumb?: (() => void) | null;
  onTool: (tool: SessionTool) => void;
}

export function sessionTopbarTpl(o: SessionTopbarOpts): TemplateResult {
  const crumbTpl = ((): TemplateResult | typeof nothing => {
    if (!o.crumb) return nothing;
    if (!o.onCrumb) return html`<span class="session-crumb">${o.crumb}</span><span class="session-crumb-sep">/</span>`;
    return html`<button
        class="session-crumb as-link"
        type="button"
        ${tip(`Open the ${o.crumb} project`)}
        @click=${(e: Event) => {
          e.stopPropagation();
          o.onCrumb!();
        }}
      >
        ${o.crumb}</button
      ><span class="session-crumb-sep">/</span>`;
  })();
  const heading = html`
    ${crumbTpl} ${o.title ? html`<span class="session-title" dir="auto">${o.title}</span>` : nothing}
    ${
      o.fork
        ? html`<button
            class="session-fork-badge"
            type="button"
            ${tip(`Forked from ${o.fork.title}${o.fork.onClick ? ". Open the original" : ""}`)}
            ?disabled=${!o.fork.onClick}
            @click=${(e: Event) => {
              e.stopPropagation();
              o.fork?.onClick?.();
            }}
          >
            ${icon(GitFork, 12)}<span>fork</span>
          </button>`
        : nothing
    }
  `;
  const tool = (t: SessionTool, glyph: Parameters<typeof icon>[0], hint: string) => {
    const count = t === "crons" || t === "apps" ? (o.toolCount?.(t) ?? null) : null;
    return html`
      <button
        class="session-tool ${o.activeTool === t ? "active" : ""}"
        type="button"
        aria-label=${hint}
        ${tip(hint)}
        @click=${() => o.onTool(t)}
      >
        ${icon(glyph, 15)}${count ? html`<span class="session-tool-count">${count}</span>` : nothing}
      </button>
    `;
  };
  const sheetTool = (t: SessionTool, glyph: Parameters<typeof icon>[0], hint: string) => {
    const count = t === "crons" || t === "apps" ? (o.toolCount?.(t) ?? null) : null;
    return html`
      <button
        class="menu-option ${o.activeTool === t ? "active" : ""}"
        type="button"
        role="menuitem"
        @click=${() => {
          closeFormMenus();
          o.onTool(t);
        }}
      >
        ${icon(glyph, 17)}
        <span class="menu-option-copy"><span class="menu-option-label">${hint}</span></span>
        ${count ? html`<span class="session-tool-count">${count}</span>` : nothing}
      </button>
    `;
  };
  return html`
    <header class="chat-topbar session-topbar">
      ${
        o.parent
          ? html`<button
                class="session-parent-link"
                type="button"
                aria-label=${`Back to parent: ${o.parent.title}`}
                ${tip(`Back to ${o.parent.title}`)}
                @click=${o.parent.onClick}
              >
                ${icon(ArrowUpLeft, 15)}<span>${o.parent.title}</span>
              </button>
              <span class="session-crumb-sep" aria-hidden="true">/</span>`
          : nothing
      }
      ${
        o.onTitle
          ? html`<button class="session-heading as-link" type="button" ${tip("Back to this chat")} @click=${o.onTitle}>
              ${heading}
            </button>`
          : html`<div class="session-heading">${heading}</div>`
      }
      <div class="topbar-actions session-tools">
        ${tool("crons", Clock3, "Crons")} ${tool("apps", Rocket, "Apps")} ${tool("files", Files, "Files")}
        ${tool("skills", Box, "Skills")} ${tool("memory", Brain, "Memory")}
        ${tool("keychain", KeyRound, "Your keychain")}
      </div>
      <div class="topbar-actions form-menu-control session-tools-more" data-align="right" data-drop="down">
        <button
          class="icon-btn menu-button session-tools-more-btn"
          type="button"
          aria-label="Session tools"
          aria-haspopup="menu"
          aria-expanded="false"
          @click=${toggleFormMenu}
        >
          ${icon(Ellipsis, 20)}
        </button>
        <div class="menu-popover" role="menu" hidden>
          <div class="menu-title">This conversation's workspace</div>
          ${sheetTool("crons", Clock3, "Crons")} ${sheetTool("apps", Rocket, "Apps")}
          ${sheetTool("files", Files, "Files")} ${sheetTool("skills", Box, "Skills")}
          ${sheetTool("memory", Brain, "Memory")} ${sheetTool("keychain", KeyRound, "Your keychain")}
        </div>
      </div>
    </header>
  `;
}

export function openProjectPage(scopeId: string): void {
  setScopedSession(null);
  void import("./contexts").then(({ openProjectDetail }) => openProjectDetail(scopeId));
}

/** Top bar for the scoped crons/files/memory views: same bar, title links back
 * to the session, tools swap views while keeping the scope. */
export function scopedViewTopbar(current: SessionTool, redraw: () => void): TemplateResult | typeof nothing {
  const active = scopedSession.active;
  if (!active) return nothing;
  return sessionTopbarTpl({
    sessionId: active.sessionId,
    crumb: active.crumb,
    title: active.title,
    onCrumb: active.crumb ? () => openProjectPage(active.scopeId) : null,
    activeTool: current,
    toolCount: (t) => scopeToolCount(t, active.scopeId, redraw),
    onTitle: () => {
      setScopedSession(null);
      void Promise.all([import("./shell"), import("./sessions")]).then(
        ([{ appState, renderSidebarTop }, { sessionsState, openSession }]) => {
          const s = sessionsState.list.find(
            (row) => (active.sessionId && row.id === active.sessionId) || row.threadRef === active.threadRef,
          );
          if (!s) return;
          appState.currentView = "chats";
          renderSidebarTop();
          void openSession(s);
        },
      );
    },
    onTool: (t) => {
      if (t === current) return;
      void import("./shell").then(({ switchView }) => switchView(t === "apps" ? "deploys" : t));
    },
  });
}
