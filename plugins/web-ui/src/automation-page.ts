import { automationEditDialog } from "./automation-edit.ts";
import { html, nothing, render, type TemplateResult } from "lit";
import { Archive, Pause, Pencil, Play, Plus, RotateCcw, Trash2 } from "lucide";
import { api, userSendMessage } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { listBackLink, listPageTpl } from "./list-page";
import { contextsState, ensureContexts, scopeChip } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { appState } from "./shell";
import { startNewChat } from "./sessions";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import { tip } from "./tooltip";

export interface AutomationView {
  id: string;
  ownerScopeId: string;
  owner: string;
  title?: string;
  action?: string;
  message?: string;
  destination?: { type: string; target: string } | null;
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
  lastFireNote?: { text: string; at: number; by?: string } | null;
  scopeName?: string;
  permission?: "read" | "manage";
}

interface AutomationRunView {
  payload?: string;
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: string;
  endedAt?: number;
  note?: string;
  reply?: string;
  sessionId?: string;
}

function automationRunTiming(run: AutomationRunView): string {
  const fired = new Date(run.firedAt).toLocaleString();
  if (run.status === "running") {
    const min = Math.max(0, Math.round((Date.now() - run.firedAt) / 60_000));
    return `${fired} — in flight for ${min}m`;
  }
  if (run.endedAt === undefined) return fired;
  return `${fired} — took ${Math.max(0, Math.round((run.endedAt - run.firedAt) / 1000))}s`;
}

export interface AutomationPageOptions<T extends AutomationView> {
  kind: "crons" | "webhooks";
  singular: string;
  title: string;
  searchText?: (item: T) => string;
  runSummary: (item: T) => string;
  runSummaryTitle: (item: T) => string;
  triggerFields: (item: T) => TemplateResult;
  editHint: string;
  editPrompt?: (item: T, title: string) => string;
  create: () => void;
  runNow?: boolean;
}

export function createAutomationPage<T extends AutomationView>(options: AutomationPageOptions<T>) {
  type AutomationTab = "yours" | "shared" | "archived";
  const AUTOMATION_TABS: Array<{ value: AutomationTab; label: string }> = [
    { value: "yours", label: "Yours" },
    { value: "shared", label: "Shared" },
    { value: "archived", label: "Archived" },
  ];

  let automationList: T[] = [];
  let visibleAutomationList: T[] = [];
  let automationsScope: string | null = null;
  let automationTab: AutomationTab = "yours";
  let showDisabledAutomations = false;
  let automationsPageHost: HTMLElement | null = null;
  let automationsLoading = false;
  let automationsNotice = "";
  let automationRefreshSeq = 0;
  let automationActionNotice = "";
  let automationMutationInFlight = false;
  let automationsSearch = "";
  const automationRuns = new Map<string, AutomationRunView[]>();
  const automationRunsLoading = new Set<string>();
  let automationDialog: { kind: "rename" | "delete"; item: T } | null = null;
  let activeAutomationId: string | null = null;
  let pendingAutomationId: string | null = null;

  function resetActiveAutomation(): void {
    automationsScope = null;
  }

  function openAutomationById(id: string): void {
    pendingAutomationId = id;
  }

  function syncAutomationUrl(automationId: string | null, push = false): void {
    if (appState.currentView !== options.kind) return;
    const next = deepLinkPath(UI_BASE, options.kind, null, null, automationId);
    if (`${location.pathname}${location.search}` === next) return;
    if (push) history.pushState(null, "", next);
    else history.replaceState(null, "", next);
  }

  function routeAutomationsHistory(automationId: string | null): void {
    if (appState.currentView !== options.kind) return;
    const item = automationId
      ? (automationList.find((c) => c.id === automationId) ?? visibleAutomationList.find((c) => c.id === automationId))
      : undefined;
    if (item) openAutomation(item);
    else drawAutomationsPage();
  }

  async function refreshAutomations(opts: { showLoading?: boolean } = {}): Promise<boolean> {
    const seq = ++automationRefreshSeq;
    if (opts.showLoading) {
      automationsLoading = true;
      automationsNotice = "";
    }
    try {
      const r = await api<Record<string, T[] | undefined>>(`/api/${options.kind}`);
      if (seq !== automationRefreshSeq) return false;
      automationList = r[options.kind] ?? [];
      visibleAutomationList = r.visible ?? [];
      automationsNotice = "";
      return true;
    } catch (e) {
      if (seq !== automationRefreshSeq) return false;
      automationsNotice = errMessage(e, `Failed to load ${options.kind}.`);
      return false;
    } finally {
      if (seq === automationRefreshSeq) automationsLoading = false;
    }
  }

  function automationText(c: T): string {
    return c.message ?? c.action ?? "";
  }

  function cleanAutomationText(text: string): string {
    return text
      .trim()
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clipWords(text: string, max = 64): string {
    const clean = cleanAutomationText(text);
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const wordCut = cut.replace(/\s+\S*$/, "");
    return `${(wordCut.length >= max * 0.55 ? wordCut : cut).trim()}…`;
  }

  function suggestedAutomationTitle(text: string): string {
    const clean = cleanAutomationText(text);
    if (!clean) return `(untitled ${options.singular})`;
    const candidate = clean
      .replace(/^(please\s+)?(run|generate|create|send|post|deliver|summarize|check)\s+(the\s+)?/i, "")
      .replace(/\s*[:;.!?]\s+.*$/, "")
      .trim();
    const clipped = clipWords(candidate || clean, 58);
    return clipped.replace(/^[a-z]/, (ch) => ch.toUpperCase());
  }

  function automationTitle(c: T): string {
    return c.title?.trim() || suggestedAutomationTitle(automationText(c));
  }

  function automationScopeLabel(c: T): string {
    const sep = c.ownerScopeId.indexOf(":");
    const kind = sep === -1 ? c.ownerScopeId : c.ownerScopeId.slice(0, sep);
    if (kind === "channel") return c.scopeName ? `#${c.scopeName}` : "a Slack channel";
    if (kind === "org") return "org-wide";
    if (kind === "group") return "group";
    return c.owner;
  }

  function isPersonalScope(c: T): boolean {
    const kind = c.ownerScopeId.split(":", 1)[0];
    return kind !== "channel" && kind !== "org" && kind !== "group";
  }

  function automationStatusLabel(c: T): "enabled" | "disabled" | "archived" {
    if (c.archived) return "archived";
    return c.enabled ? "enabled" : "disabled";
  }

  function automationStatusText(c: T): string {
    const status = automationStatusLabel(c);
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  async function renderAutomationsPage(): Promise<void> {
    if (appState.currentView !== options.kind) return;
    if (scopedSession.active) automationsScope = scopedSession.active.scopeId;
    else if (contextsState.selected) {
      automationsScope = contextsState.selected;
      contextsState.selected = null;
    } else automationsScope = null;
    await ensureContexts();
    drawAutomationsPage();
    const loaded = await refreshAutomations({
      showLoading: automationList.length === 0 && visibleAutomationList.length === 0,
    });
    const wanted = pendingAutomationId;
    pendingAutomationId = null;
    if (appState.currentView !== options.kind) return;
    if (!loaded) return drawAutomationsPage();
    const item = wanted
      ? (automationList.find((c) => c.id === wanted) ?? visibleAutomationList.find((c) => c.id === wanted))
      : undefined;
    if (wanted && !item) {
      automationActionNotice = `That ${options.singular} wasn't found, or you don't have access to it.`;
    }
    if (item) openAutomation(item);
    else drawAutomationsPage();
  }

  function drawAutomationsPage(): void {
    if (appState.currentView !== options.kind || !appState.mainEl) return;
    activeAutomationId = null;
    syncAutomationUrl(null);
    if (!automationsPageHost || automationsPageHost.parentElement !== appState.mainEl) {
      automationsPageHost = document.createElement("div");
      automationsPageHost.className = "pane crons-page";
      appState.mainEl.replaceChildren(automationsPageHost);
    }
    const all = [
      ...automationList.map((c) => ({ c, mine: true })),
      ...visibleAutomationList.map((c) => ({ c, mine: false })),
    ]
      .filter(({ c }) => (automationsScope ? c.ownerScopeId === automationsScope : true))
      .filter(
        ({ c }) =>
          !automationsSearch.trim() ||
          `${automationTitle(c)} ${automationText(c)} ${c.scopeName ?? ""} ${options.searchText?.(c) ?? ""}`
            .toLowerCase()
            .includes(automationsSearch.trim().toLowerCase()),
      )
      .sort((a, b) => b.c.createdAt - a.c.createdAt);
    const archived = all.filter(({ c }) => c.archived);
    const yours = all.filter(({ c, mine }) => mine && !c.archived);
    const yoursEnabled = yours.filter(({ c }) => c.enabled);
    const yoursDisabled = yours.filter(({ c }) => !c.enabled);
    const shared = all.filter(({ c, mine }) => !mine && !c.archived);
    const ownsAny = all.some(({ mine }) => mine);
    const counts: Record<AutomationTab, number> = {
      yours: yoursEnabled.length,
      shared: shared.filter(({ c }) => c.enabled).length,
      archived: archived.length,
    };

    const rows: TemplateResult[] = [];
    if (automationActionNotice) {
      rows.push(html`<div class="action-notice">${automationActionNotice}</div>`);
      automationActionNotice = "";
    }
    if (all.length) rows.push(automationTabs(counts, shared.length > 0));
    if (automationTab === "yours") {
      rows.push(...yoursEnabled.map(({ c }) => automationPageRow(c, true)));
      if (all.length && !yoursEnabled.length)
        rows.push(automationEmptyRow(ownsAny ? `No active ${options.kind}.` : `None of your own ${options.kind} yet.`));
      if (yoursDisabled.length) {
        rows.push(automationDisabledToggle(yoursDisabled.length));
        if (showDisabledAutomations) rows.push(...yoursDisabled.map(({ c }) => automationPageRow(c, true)));
      }
    } else if (automationTab === "shared") {
      rows.push(...shared.map(({ c }) => automationPageRow(c, false)));
      if (!shared.length) rows.push(automationEmptyRow(`No ${options.kind} shared with you.`));
    } else {
      rows.push(...archived.map(({ c, mine }) => automationPageRow(c, mine)));
      if (!archived.length) rows.push(automationEmptyRow("Nothing archived."));
    }
    let empty = `No ${options.kind} yet.`;
    if (automationsNotice) empty = automationsNotice;
    else if (automationsLoading && automationList.length === 0 && visibleAutomationList.length === 0)
      empty = `Loading ${options.kind}…`;
    else if (automationsScope) empty = `No ${options.kind} in this context.`;
    const scoped = Boolean(scopedSession.active);
    automationsPageHost.classList.toggle("scoped-view", scoped);
    render(
      html`${options.kind === "crons" ? scopedViewTopbar("crons", drawAutomationsPage) : nothing}
      ${listPageTpl({
        title: options.title,
        ...(options.kind === "webhooks"
          ? {
              scope: automationsScope,
              onScope: (scope: string | null) => {
                automationsScope = scope;
                drawAutomationsPage();
              },
            }
          : {}),
        action: options.kind === "webhooks" ? { label: `New ${options.singular}`, onClick: options.create } : undefined,
        search: {
          value: automationsSearch,
          placeholder: `Search ${options.kind}`,
          onInput: (value) => {
            automationsSearch = value;
            drawAutomationsPage();
          },
        },
        rows,
        empty,
      })}`,
      automationsPageHost,
    );
  }

  function setAutomationTab(tab: AutomationTab): void {
    automationTab = tab;
    drawAutomationsPage();
  }

  function toggleDisabledAutomations(): void {
    showDisabledAutomations = !showDisabledAutomations;
    drawAutomationsPage();
  }

  function automationEmptyRow(text: string): TemplateResult {
    return html`<div class="empty compact cron-filter-empty">${text}</div>`;
  }

  function automationTabs(counts: Record<AutomationTab, number>, hasShared: boolean): TemplateResult {
    const tabs = AUTOMATION_TABS.filter(
      (t) =>
        t.value === "yours" || (t.value === "shared" && hasShared) || counts[t.value] > 0 || automationTab === t.value,
    );
    return html`
      <div class="cron-list-controls" role="tablist" aria-label="Automation view">
        ${tabs.map(
          (t) => html`
            <button
              type="button"
              role="tab"
              aria-selected=${automationTab === t.value}
              class="cron-filter-chip ${automationTab === t.value ? "active" : ""}"
              @click=${() => setAutomationTab(t.value)}
            >
              <span>${t.label}</span>
              <span class="cron-filter-count">${counts[t.value]}</span>
            </button>
          `,
        )}
      </div>
    `;
  }

  function automationDisabledToggle(count: number): TemplateResult {
    return html`
      <button class="archived-toggle cron-disabled-toggle" type="button" @click=${toggleDisabledAutomations}>
        <span>${showDisabledAutomations ? "Hide disabled" : "Show disabled"}</span>
        <span class="archived-count">${count}</span>
      </button>
    `;
  }

  function canManageAutomation(c: T, mine: boolean): boolean {
    return c.permission ? c.permission === "manage" : mine;
  }

  function automationPageRow(c: T, mine: boolean): TemplateResult {
    const status = automationStatusLabel(c);
    return html`
      <div class="list-row cron-row cron-${status}">
        <a
          class="cron-row-main"
          href=${deepLinkPath(UI_BASE, options.kind, null, null, c.id)}
          @click=${(event: MouseEvent) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            openAutomation(c, { push: true });
          }}
        >
          <span class="list-row-title cron-title-line"><span dir="auto">${automationTitle(c)}</span></span>
          <span class="list-row-meta">
            ${isPersonalScope(c) ? nothing : scopeChip(c.ownerScopeId, c.scopeName ?? null)}
            <span class="cron-meta-line" ${tip(options.runSummaryTitle(c))}>${options.runSummary(c)}</span>
          </span>
        </a>
        ${canManageAutomation(c, mine) ? automationRowActions(c) : nothing}
      </div>
    `;
  }

  function automationRowActions(c: T): TemplateResult {
    let stateAction = html`
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("Enable")}
        aria-label=${`Enable ${options.singular}`}
        @click=${() => void setAutomationEnabled(c.id, true)}
      >
        ${icon(Play, 14)}
      </button>
    `;
    if (c.archived) {
      stateAction = html`
        <button
          class="icon-btn subtle compact"
          type="button"
          ${tip("Unarchive")}
          aria-label=${`Unarchive ${options.singular}`}
          @click=${() => void archiveAutomation(c.id, false)}
        >
          ${icon(RotateCcw, 14)}
        </button>
      `;
    } else if (c.enabled) {
      stateAction = html`
        <button
          class="icon-btn subtle compact"
          type="button"
          ${tip("Disable")}
          aria-label=${`Disable ${options.singular}`}
          @click=${() => void setAutomationEnabled(c.id, false)}
        >
          ${icon(Pause, 14)}
        </button>
      `;
    }
    return html`
      <div class="cron-row-actions" aria-label=${`${options.singular} actions`}>
        <button
          class="icon-btn subtle compact"
          type="button"
          ${tip("Edit")}
          aria-label=${`Edit ${options.singular}`}
          @click=${() => {
            openAutomation(c);
            showAutomationDialog("rename", c);
          }}
        >
          ${icon(Pencil, 14)}
        </button>
        ${stateAction}
        ${
          c.archived
            ? nothing
            : html`
                <button
                  class="icon-btn subtle compact"
                  type="button"
                  ${tip("Archive")}
                  aria-label=${`Archive ${options.singular}`}
                  @click=${() => void archiveAutomation(c.id, true)}
                >
                  ${icon(Archive, 14)}
                </button>
              `
        }
      </div>
    `;
  }

  function openAutomation(c: T, opts: { push?: boolean; refreshRuns?: boolean } = {}): void {
    if (!appState.mainEl) return;
    const shouldRefreshRuns = opts.refreshRuns || activeAutomationId !== c.id;
    activeAutomationId = c.id;
    syncAutomationUrl(c.id, opts.push);
    const mine = automationList.some((x) => x.id === c.id);
    const manageable = canManageAutomation(c, mine);
    const notice = automationActionNotice;
    automationActionNotice = "";
    let stateActions = html`
      <button class="btn" @click=${() => void setAutomationEnabled(c.id, true)}>
        ${icon(Play, 15)}<span>Enable</span>
      </button>
      <button class="btn" @click=${() => void archiveAutomation(c.id, true)}>
        ${icon(Archive, 15)}<span>Archive</span>
      </button>
    `;
    if (c.archived) {
      stateActions = html`<button class="btn" @click=${() => void archiveAutomation(c.id, false)}>
        ${icon(RotateCcw, 15)}<span>Unarchive</span>
      </button>`;
    } else if (c.enabled) {
      stateActions = html`
        ${options.runNow ? html`<button class="btn" @click=${() => void runAutomationNow(c.id)}>${icon(Play, 15)}<span>Run now</span></button>` : nothing}
        <button class="btn" @click=${() => void setAutomationEnabled(c.id, false)}>
          ${icon(Pause, 15)}<span>Disable</span>
        </button>
        <button class="btn" @click=${() => void archiveAutomation(c.id, true)}>
          ${icon(Archive, 15)}<span>Archive</span>
        </button>
      `;
    }
    const host = document.createElement("div");
    host.className = "resource-pane cron-pane";
    render(
      html`
        <div class="resource-detail">
          ${listBackLink(options.title, drawAutomationsPage)}
          <div class="resource-heading">
            <h2 dir="auto">${automationTitle(c)}</h2>
            <button class="btn" @click=${options.create}>${icon(Plus, 15)}<span>New ${options.singular}</span></button>
          </div>
          ${notice ? html`<div class="hint">${notice}</div>` : ""}
          <div class="field">
            <label>Context</label>
            <div class="value">${scopeChip(c.ownerScopeId, c.scopeName ?? null)}</div>
          </div>
          ${
            c.title
              ? html`<div class="field">
                  <label>Title</label>
                  <div class="value" dir="auto">${c.title}</div>
                </div>`
              : nothing
          }
          <div class="field">
            <label>${c.message !== undefined ? "Message" : "Task"}</label>
            <div class="value pre">${automationText(c)}</div>
          </div>
          ${options.triggerFields(c)}
          ${
            mine
              ? ""
              : html`<div class="field">
                  <label>Owner</label>
                  <div class="value">${c.owner}</div>
                </div>`
          }
          ${
            mine
              ? ""
              : html`<div class="field">
                  <label>Scope</label>
                  <div class="value">${automationScopeLabel(c)}</div>
                </div>`
          }
          <div class="field">
            <label>Status</label>
            <div class="value">${automationStatusText(c)}</div>
          </div>
          ${
            c.destination
              ? html`<div class="field">
                  <label>Destination</label>
                  <div class="value">${c.destination.type} → ${c.destination.target}</div>
                </div>`
              : ""
          }
          <div class="field">
            <label>Last fired</label>
            <div class="value">${c.lastFiredAt ? new Date(c.lastFiredAt).toLocaleString() : "Never"}</div>
          </div>
          ${
            c.lastFireNote
              ? html`<div class="field">
                  <label>
                    ${c.lastFireNote.by ? `Note left by ${c.lastFireNote.by}` : "Note from last fire"}
                    (${new Date(c.lastFireNote.at).toLocaleString()})
                  </label>
                  <div class="value" dir="auto">${c.lastFireNote.text}</div>
                </div>`
              : nothing
          }
          ${manageable ? automationRunHistory(c) : nothing}
          ${
            manageable
              ? html`
                  <div class="actions">
                    <button class="btn" @click=${() => showAutomationDialog("rename", c)}>
                      ${icon(Pencil, 15)}<span>Edit</span>
                    </button>
                    ${stateActions}
                    <button class="btn danger" @click=${() => showAutomationDialog("delete", c)}>
                      ${icon(Trash2, 15)}<span>Delete</span>
                    </button>
                  </div>
                `
              : html`<div class="hint">
                  Shared from ${automationScopeLabel(c)}. You can view it, but not change it.
                </div>`
          }
          ${automationDialog?.item.id === c.id ? automationDialogTpl(automationDialog) : nothing}
        </div>
      `,
      host,
    );
    appState.mainEl.replaceChildren(host);
    if (manageable && (shouldRefreshRuns || !automationRuns.has(c.id)) && !automationRunsLoading.has(c.id))
      void loadAutomationRuns(c.id);
  }

  function automationRunHistory(c: T): TemplateResult {
    const runs = automationRuns.get(c.id);
    const heading = html`<div class="cron-run-heading">
      <label>Recent runs</label>
    </div>`;
    if (!runs)
      return html`<div class="field">
        ${heading}
        <div class="hint">Loading…</div>
      </div>`;
    if (!runs.length)
      return html`<div class="field">
        ${heading}
        <div class="hint">No runs yet.</div>
      </div>`;
    return html` <div class="field">
      ${heading}
      <div class="cron-run-list">
        ${[...runs].reverse().map((run) => {
          const detail = run.note ?? (run.reply ? clipWords(run.reply, 120) : "");
          return html` <div class="cron-run-row">
              <span class="badge">${run.status ?? (run.payload !== undefined ? "received" : "completed")}</span>
              <span class="cron-run-time">${automationRunTiming(run)}</span>
              <span class=${run.note ? "cron-run-detail cron-run-error" : "cron-run-detail"} ${tip(detail)}>
                ${detail}
              </span>
              ${
                run.sessionId
                  ? html`<a class="cron-run-link" href=${deepLinkPath(UI_BASE, "chats", run.sessionId)}>Worklog</a>`
                  : nothing
              }
            </div>
            ${
              run.payload !== undefined
                ? html`<details class="automation-run-input">
                    <summary>Event payload</summary>
                    <pre class="tool-payload-body">${run.payload}</pre>
                  </details>`
                : nothing
            }`;
        })}
      </div>
    </div>`;
  }

  async function loadAutomationRuns(id: string): Promise<void> {
    automationRunsLoading.add(id);
    try {
      const result = await api<{ runs: AutomationRunView[] }>(`/api/${options.kind}/${encodeURIComponent(id)}/runs`);
      automationRuns.set(id, result.runs ?? []);
    } catch (error) {
      automationActionNotice = errMessage(error, "Couldn't load run history.");
      automationRuns.set(id, []);
    } finally {
      automationRunsLoading.delete(id);
    }
    if (activeAutomationId !== id || appState.currentView !== options.kind) return;
    const current =
      automationList.find((candidate) => candidate.id === id) ??
      visibleAutomationList.find((candidate) => candidate.id === id);
    if (current) openAutomation(current);
  }

  async function reopenAutomation(id: string): Promise<void> {
    await refreshAutomations();
    const c = automationList.find((x) => x.id === id) ?? visibleAutomationList.find((x) => x.id === id);
    if (c) openAutomation(c, { refreshRuns: true });
    else drawAutomationsPage();
  }

  async function automationMutate<T>(fn: () => Promise<T>, busyValue: T): Promise<T> {
    if (automationMutationInFlight) return busyValue;
    automationMutationInFlight = true;
    try {
      return await fn();
    } finally {
      automationMutationInFlight = false;
    }
  }

  function runAutomationNow(id: string): Promise<void> {
    return automationMutate(async () => {
      try {
        await api(`/api/${options.kind}/${encodeURIComponent(id)}/run`, { method: "POST" });
        automationActionNotice = "Run started. Refresh recent runs after it completes.";
      } catch (e) {
        automationActionNotice = errMessage(e, "run failed");
      }
      await reopenAutomation(id);
    }, undefined);
  }

  function patchAutomation(
    id: string,
    patch: { title?: string; task?: string; enabled?: boolean; archived?: boolean },
    errorLabel: string,
  ): Promise<boolean> {
    return automationMutate(async () => {
      try {
        await api(`/api/${options.kind}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
        return true;
      } catch (e) {
        automationActionNotice = errMessage(e, errorLabel);
        await reopenAutomation(id);
        return false;
      }
    }, false);
  }

  function showAutomationDialog(kind: "rename" | "delete", item: T): void {
    automationDialog = { kind, item };
    openAutomation(item);
  }

  function closeAutomationDialog(c: T): void {
    automationDialog = null;
    openAutomation(c);
  }

  function automationDialogTpl(dialog: { kind: "rename" | "delete"; item: T }): TemplateResult {
    const c = dialog.item;
    if (dialog.kind === "delete") {
      return html` <div
        class="project-dialog-backdrop"
        @click=${(event: MouseEvent) => event.target === event.currentTarget && closeAutomationDialog(c)}
      >
        <div
          class="project-dialog automation-edit-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cron-delete-title"
        >
          <div class="project-dialog-head">
            <div>
              <h2 id="cron-delete-title">Delete <bdi>${automationTitle(c)}</bdi>?</h2>
            </div>
          </div>
          <p>This permanently removes the automation. Archive it instead if you may need it later.</p>
          <div class="project-dialog-actions">
            <button class="btn" type="button" @click=${() => closeAutomationDialog(c)}>Cancel</button>
            <button class="btn danger" type="button" @click=${() => void confirmDeleteAutomation(c.id)}>
              Delete permanently
            </button>
          </div>
        </div>
      </div>`;
    }
    return automationEditDialog({
      heading: `Edit ${options.singular}`,
      title: c.title ?? automationTitle(c),
      ...(c.message === undefined ? { task: automationText(c) } : { message: c.message }),
      hint: options.editHint,
      onCancel: () => closeAutomationDialog(c),
      onEditWithAgent: options.editPrompt ? () => editAutomationWithAgent(c) : undefined,
      onSave: async (patch) => {
        const saved = await automationMutate(async () => {
          await api(`/api/${options.kind}/${encodeURIComponent(c.id)}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
          });
          return true;
        }, false);
        if (!saved) throw new Error("Another update is in progress. Try again shortly.");
      },
      onSaved: async () => {
        automationDialog = null;
        automationActionNotice = `${options.singular === "cron" ? "Cron" : "Webhook"} updated.`;
        await reopenAutomation(c.id);
      },
    });
  }

  function editAutomationWithAgent(c: T): void {
    automationDialog = null;
    const conv = startNewChat();
    void conv?.state.agent?.prompt(userSendMessage(options.editPrompt!(c, automationTitle(c))));
  }

  async function archiveAutomation(id: string, archived: boolean): Promise<void> {
    const ok = await patchAutomation(id, { archived }, archived ? "archive failed" : "unarchive failed");
    if (!ok) return;
    await refreshAutomations();
    if (archived) {
      automationTab = "yours";
      drawAutomationsPage();
      return;
    }
    automationTab = "yours";
    showDisabledAutomations = true;
    await reopenAutomation(id);
  }

  function setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
    return automationMutate(async () => {
      try {
        await api(`/api/${options.kind}/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
          method: "POST",
        });
        automationTab = "yours";
        if (!enabled) showDisabledAutomations = true;
      } catch (e) {
        automationActionNotice = errMessage(e, enabled ? "enable failed" : "disable failed");
      }
      await reopenAutomation(id);
    }, undefined);
  }

  async function confirmDeleteAutomation(id: string): Promise<void> {
    await automationMutate(async () => {
      automationDialog = null;
      try {
        await api(`/api/${options.kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (e) {
        automationActionNotice = errMessage(e, "delete failed");
      }
      await reopenAutomation(id);
    }, undefined);
  }

  return {
    reset: resetActiveAutomation,
    openById: openAutomationById,
    routeHistory: routeAutomationsHistory,
    render: renderAutomationsPage,
    list: drawAutomationsPage,
    open: openAutomation,
    refresh: refreshAutomations,
  };
}
