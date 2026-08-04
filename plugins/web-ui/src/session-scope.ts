import { html, nothing, type TemplateResult } from "lit";
import { Brain, Clock3, Files } from "lucide";
import { api } from "./core-bridge";
import { icon } from "./ui";

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

const cronCountCache = new Map<string, { count: number; at: number }>();
const cronCountInFlight = new Set<string>();

/** Cached count of enabled crons owned by a scope; kicks off a refresh and
 * calls onReady when a fresh count lands. */
export function scopeCronCount(scope: string, onReady: () => void): number | null {
  const hit = cronCountCache.get(scope);
  if (hit && Date.now() - hit.at < 60_000) return hit.count;
  if (!cronCountInFlight.has(scope)) {
    cronCountInFlight.add(scope);
    void api<{ crons?: CronLite[]; visible?: CronLite[] }>("/api/crons")
      .then((r) => {
        const seen = new Set<string>();
        let count = 0;
        for (const c of [...(r.crons ?? []), ...(r.visible ?? [])]) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          if (c.ownerScopeId === scope && c.enabled && !c.archived) count++;
        }
        cronCountCache.set(scope, { count, at: Date.now() });
      })
      .catch(() => cronCountCache.set(scope, { count: hit?.count ?? 0, at: Date.now() }))
      .finally(() => {
        cronCountInFlight.delete(scope);
        onReady();
      });
  }
  return hit?.count ?? null;
}

export type SessionTool = "crons" | "files" | "memory";

export interface SessionTopbarOpts {
  crumb: string | null;
  title: string;
  pill?: "working" | "needs-you" | null;
  activeTool?: SessionTool | null;
  cronCount?: number | null;
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
        title="Open the ${o.crumb} project"
        @click=${(e: Event) => {
          e.stopPropagation();
          o.onCrumb!();
        }}
      >
        ${o.crumb}</button
      ><span class="session-crumb-sep">/</span>`;
  })();
  const heading = html`
    ${crumbTpl}
    <span class="session-title">${o.title}</span>
    ${
      o.pill
        ? html`<span class="session-pill ${o.pill === "needs-you" ? "needs-you" : "working"}"
            ><span class="pill-dot"></span>${o.pill === "needs-you" ? "needs you" : "working"}</span
          >`
        : nothing
    }
  `;
  const headingTitle = o.crumb
    ? `This chat runs in the ${o.crumb} context — the agent works with that context's files and memory, separate from your personal context.`
    : o.title;
  const tool = (t: SessionTool, glyph: Parameters<typeof icon>[0], label: string, hint: string) => html`
    <button
      class="session-tool ${o.activeTool === t ? "active" : ""}"
      type="button"
      title=${hint}
      @click=${() => o.onTool(t)}
    >
      ${icon(glyph, 15)}<span>${label}</span>
    </button>
  `;
  const cronLabel = o.cronCount ? `${o.cronCount} ${o.cronCount === 1 ? "cron" : "crons"}` : "Crons";
  return html`
    <header class="chat-topbar session-topbar">
      ${
        o.onTitle
          ? html`<button class="session-heading as-link" type="button" title="Back to this chat" @click=${o.onTitle}>
              ${heading}
            </button>`
          : html`<div class="session-heading" title=${headingTitle}>${heading}</div>`
      }
      <div class="topbar-actions session-tools">
        ${tool("crons", Clock3, cronLabel, "Crons in this context")}
        ${tool("files", Files, "Files", "Files in this context")} ${tool("memory", Brain, "Memory", "Memory")}
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
    crumb: active.crumb,
    title: active.title,
    onCrumb: active.crumb ? () => openProjectPage(active.scopeId) : null,
    activeTool: current,
    cronCount: scopeCronCount(active.scopeId, redraw),
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
      void import("./shell").then(({ switchView }) => switchView(t));
    },
  });
}
