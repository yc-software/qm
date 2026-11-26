import { html, nothing, render, type TemplateResult } from "lit";
import { Archive, Ellipsis, Pause, Pencil, Play, Plus, RotateCcw, Sparkles, Trash2 } from "lucide";
import { openShare, shareButton } from "./share-dialog";
import { cronDeliveryList } from "./cron-delivery";
import { friendlyPrincipal } from "./app-view";
import { draftFromSchedule, schedulePicker, type ScheduleDraft } from "./cron-schedule-picker";
import { closeFormMenus, relTime, toggleFormMenu } from "./ui";
import { api, userSendMessage } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { listBackLink, listPageTpl } from "./list-page";
import { contextsState, ensureContexts, scopeChip } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { appState } from "./shell";
import { startNewChat } from "./sessions";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import {
  cronNextFire,
  cronRunSummary,
  cronRunSummaryTitle,
  cronScheduleSummary,
  describeSchedule,
  formatCronDateTime,
  timezoneLabel,
} from "./cron-format";
import { tip } from "./tooltip";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { rememberScopeLabels } from "./scope-labels";

export interface CronView {
  id: string;
  ownerScopeId: string;
  owner: string;
  title?: string;
  action?: string;
  message?: string;
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  destination?: { type: string; target: string; audienceScopeId?: string } | null;
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
  lastFireNote?: { text: string; at: number; by?: string } | null;
  scopeName?: string;
  permission?: "read" | "manage";
  sharedFrom?: string;
  sharedBy?: string;
  forkedAt?: number;
  copies?: Array<{ id: string; owner: string; status: "on" | "paused" | "edited"; deliversTo?: string }>;
}

interface CronRunView {
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

function cronRunTiming(run: CronRunView): string {
  const fired = new Date(run.firedAt).toLocaleString();
  if (run.status === "running") {
    const min = Math.max(0, Math.round((Date.now() - run.firedAt) / 60_000));
    return `${fired} — in flight for ${min}m`;
  }
  if (run.endedAt === undefined) return fired;
  return `${fired} — took ${Math.max(0, Math.round((run.endedAt - run.firedAt) / 1000))}s`;
}

type CronTab = "yours" | "shared" | "archived";
const CRON_TABS: Array<{ value: CronTab; label: string }> = [
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared" },
  { value: "archived", label: "Archived" },
];

let cronList: CronView[] = [];
let visibleCronList: CronView[] = [];
let cronsScope: string | null = null;
let cronTab: CronTab = "yours";
let showDisabledCrons = false;
let cronsPageHost: HTMLElement | null = null;
let cronsLoading = false;
let cronsNotice = "";
let cronRefreshSeq = 0;
let cronActionNotice: { cronId: string | null; text: string } | null = null;
let cronMutationInFlight = false;
let cronsSearch = "";
const cronRuns = new Map<string, CronRunView[]>();
const cronRunsLoading = new Set<string>();
let cronDialog: { kind: "delete"; cron: CronView; opener: HTMLElement | null } | null = null;
type CronEditField = "title" | "task" | "schedule";
let cronEdit: { id: string; field: CronEditField } | null = null;
let scheduleDraft: ScheduleDraft | null = null;
const cronShares = new Map<string, Array<{ scope: string; permission: "read" | "write" }>>();
let activeCronId: string | null = null;
let pendingCronId: string | null = null;

function clearCronDetailState(clearNotice = true): void {
  cronDialog = null;
  cronEdit = null;
  scheduleDraft = null;
  if (clearNotice) cronActionNotice = null;
}

export function resetActiveCron(): void {
  cronsScope = null;
  activeCronId = null;
  clearCronDetailState();
}

export function openCronById(id: string): void {
  pendingCronId = id;
}

function syncCronUrl(cronId: string | null, push = false): void {
  if (appState.currentView !== "crons") return;
  const next = deepLinkPath(UI_BASE, "crons", null, null, cronId);
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function routeCronsHistory(cronId: string | null): void {
  if (appState.currentView !== "crons") return;
  const cron = cronId
    ? (cronList.find((c) => c.id === cronId) ?? visibleCronList.find((c) => c.id === cronId))
    : undefined;
  if (cron) openCron(cron);
  else drawCronsPage();
}

async function refreshCrons(opts: { showLoading?: boolean } = {}): Promise<boolean> {
  const seq = ++cronRefreshSeq;
  if (opts.showLoading) {
    cronsLoading = true;
    cronsNotice = "";
  }
  try {
    const r = await api<{ crons: CronView[]; visible?: CronView[] }>("/api/crons");
    if (seq !== cronRefreshSeq) return false;
    cronList = r.crons ?? [];
    visibleCronList = r.visible ?? [];
    cronsNotice = "";
    return true;
  } catch (e) {
    if (seq !== cronRefreshSeq) return false;
    cronsNotice = errMessage(e, "Failed to load crons.");
    return false;
  } finally {
    if (seq === cronRefreshSeq) cronsLoading = false;
  }
}

function cronText(c: Pick<CronView, "action" | "message">): string {
  return c.message ?? c.action ?? "";
}

function cleanCronText(text: string): string {
  return text
    .trim()
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clipWords(text: string, max = 64): string {
  const clean = cleanCronText(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const wordCut = cut.replace(/\s+\S*$/, "");
  return `${(wordCut.length >= max * 0.55 ? wordCut : cut).trim()}…`;
}

export function cronTitle(c: Pick<CronView, "title" | "action" | "message">): string {
  return c.title?.trim() || clipWords(cronText(c), 58) || "(untitled cron)";
}

function cronScopeLabel(c: CronView): string {
  const sep = c.ownerScopeId.indexOf(":");
  const kind = sep === -1 ? c.ownerScopeId : c.ownerScopeId.slice(0, sep);
  if (kind === "channel") return c.scopeName ? `#${c.scopeName}` : "a Slack channel";
  if (kind === "org") return "org-wide";
  if (kind === "group") return "group";
  return c.owner;
}

function isPersonalScope(c: CronView): boolean {
  const kind = c.ownerScopeId.split(":", 1)[0];
  return kind !== "channel" && kind !== "org" && kind !== "group";
}

function cronStatusLabel(c: CronView): "enabled" | "disabled" | "archived" {
  if (c.archived) return "archived";
  return c.enabled ? "enabled" : "disabled";
}

export async function renderCronsPage(): Promise<void> {
  if (appState.currentView !== "crons") return;
  if (scopedSession.active) cronsScope = scopedSession.active.scopeId;
  else if (contextsState.selected) {
    cronsScope = contextsState.selected;
    contextsState.selected = null;
  } else cronsScope = null;
  await ensureContexts();
  drawCronsPage();
  const loaded = await refreshCrons({ showLoading: cronList.length === 0 && visibleCronList.length === 0 });
  const wanted = pendingCronId;
  pendingCronId = null;
  if (appState.currentView !== "crons") return;
  if (!loaded) return drawCronsPage();
  const cron = wanted
    ? (cronList.find((c) => c.id === wanted) ?? visibleCronList.find((c) => c.id === wanted))
    : undefined;
  if (wanted && !cron) {
    cronActionNotice = { cronId: null, text: "That cron wasn't found, or you don't have access to it." };
  }
  if (cron) openCron(cron);
  else drawCronsPage();
}

function drawCronsPage(): void {
  if (appState.currentView !== "crons" || !appState.mainEl) return;
  activeCronId = null;
  clearCronDetailState(false);
  syncCronUrl(null);
  if (!cronsPageHost || cronsPageHost.parentElement !== appState.mainEl) {
    cronsPageHost = document.createElement("div");
    cronsPageHost.className = "pane crons-page";
    appState.mainEl.replaceChildren(cronsPageHost);
  }
  const all = [...cronList.map((c) => ({ c, mine: true })), ...visibleCronList.map((c) => ({ c, mine: false }))]
    .filter(({ c }) => (cronsScope ? c.ownerScopeId === cronsScope : true))
    .filter(
      ({ c }) =>
        !cronsSearch.trim() ||
        `${cronTitle(c)} ${cronText(c)} ${c.scopeName ?? ""}`.toLowerCase().includes(cronsSearch.trim().toLowerCase()),
    )
    .sort((a, b) => b.c.createdAt - a.c.createdAt);
  const archived = all.filter(({ c }) => c.archived);
  const yours = all.filter(({ c, mine }) => mine && !c.archived);
  const yoursEnabled = yours.filter(({ c }) => c.enabled);
  const yoursDisabled = yours.filter(({ c }) => !c.enabled);
  const shared = all.filter(({ c, mine }) => !mine && !c.archived);
  const ownsAny = all.some(({ mine }) => mine);
  const counts: Record<CronTab, number> = {
    yours: yoursEnabled.length,
    shared: shared.filter(({ c }) => c.enabled).length,
    archived: archived.length,
  };

  const rows: TemplateResult[] = [];
  if (cronActionNotice?.cronId === null) {
    rows.push(html`<div class="action-notice">${cronActionNotice.text}</div>`);
    cronActionNotice = null;
  }
  if (all.length) rows.push(cronTabs(counts, shared.length > 0));
  if (cronTab === "yours") {
    rows.push(...yoursEnabled.map(({ c }) => cronPageRow(c, true)));
    if (all.length && !yoursEnabled.length)
      rows.push(cronEmptyRow(ownsAny ? "No active crons." : "None of your own crons yet."));
    if (yoursDisabled.length) {
      rows.push(cronDisabledToggle(yoursDisabled.length));
      if (showDisabledCrons) rows.push(...yoursDisabled.map(({ c }) => cronPageRow(c, true)));
    }
  } else if (cronTab === "shared") {
    rows.push(...shared.map(({ c }) => cronPageRow(c, false)));
    if (!shared.length) rows.push(cronEmptyRow("No crons shared with you."));
  } else {
    rows.push(...archived.map(({ c, mine }) => cronPageRow(c, mine)));
    if (!archived.length) rows.push(cronEmptyRow("Nothing archived."));
  }
  let empty = "No crons yet.";
  if (cronsNotice) empty = cronsNotice;
  else if (cronsLoading && cronList.length === 0 && visibleCronList.length === 0) empty = "Loading crons…";
  else if (cronsScope) empty = "No crons in this context.";
  const scoped = Boolean(scopedSession.active);
  cronsPageHost.classList.toggle("scoped-view", scoped);
  render(
    html`${scopedViewTopbar("crons", drawCronsPage)}
    ${listPageTpl({
      title: "Crons",
      search: {
        value: cronsSearch,
        placeholder: "Search crons",
        onInput: (value) => {
          cronsSearch = value;
          drawCronsPage();
        },
      },
      rows,
      empty,
    })}`,
    cronsPageHost,
  );
}

function setCronTab(tab: CronTab): void {
  cronTab = tab;
  drawCronsPage();
}

function toggleDisabledCrons(): void {
  showDisabledCrons = !showDisabledCrons;
  drawCronsPage();
}

function cronEmptyRow(text: string): TemplateResult {
  return html`<div class="empty compact cron-filter-empty">${text}</div>`;
}

function cronTabs(counts: Record<CronTab, number>, hasShared: boolean): TemplateResult {
  const tabs = CRON_TABS.filter(
    (t) => t.value === "yours" || (t.value === "shared" && hasShared) || counts[t.value] > 0 || cronTab === t.value,
  );
  return html`
    <div class="cron-list-controls" role="tablist" aria-label="Cron view">
      ${tabs.map(
        (t) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${cronTab === t.value}
            class="cron-filter-chip ${cronTab === t.value ? "active" : ""}"
            @click=${() => setCronTab(t.value)}
          >
            <span>${t.label}</span>
            <span class="cron-filter-count">${counts[t.value]}</span>
          </button>
        `,
      )}
    </div>
  `;
}

function cronDisabledToggle(count: number): TemplateResult {
  return html`
    <button class="archived-toggle cron-disabled-toggle" type="button" @click=${toggleDisabledCrons}>
      <span>${showDisabledCrons ? "Hide disabled" : "Show disabled"}</span>
      <span class="archived-count">${count}</span>
    </button>
  `;
}

function canManageCron(c: CronView, mine: boolean): boolean {
  return c.permission ? c.permission === "manage" : mine;
}

function cronPageRow(c: CronView, mine: boolean): TemplateResult {
  const status = cronStatusLabel(c);
  return html`
    <div class="list-row cron-row cron-${status}">
      <a
        class="cron-row-main"
        href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}
        @click=${(event: MouseEvent) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          openCron(c, { push: true });
        }}
      >
        <span class="list-row-title cron-title-line"><span dir="auto">${cronTitle(c)}</span></span>
        <span class="list-row-meta">
          ${isPersonalScope(c) ? nothing : scopeChip(c.ownerScopeId, c.scopeName ?? null)}
          <span class="cron-meta-line" ${tip(cronRunSummaryTitle(c))}>${cronRunSummary(c)}</span>
        </span>
      </a>
      ${canManageCron(c, mine) ? cronRowActions(c) : nothing}
    </div>
  `;
}

function cronRowActions(c: CronView): TemplateResult {
  let stateAction = html`
    <button
      class="icon-btn subtle compact"
      type="button"
      ${tip("Enable")}
      aria-label="Enable cron"
      @click=${() => void setCronEnabled(c.id, true)}
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
        aria-label="Unarchive cron"
        @click=${() => void archiveCron(c.id, false)}
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
        aria-label="Disable cron"
        @click=${() => void setCronEnabled(c.id, false)}
      >
        ${icon(Pause, 14)}
      </button>
    `;
  }
  return html`
    <div class="cron-row-actions" aria-label="Cron actions">
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("Edit")}
        aria-label="Edit cron"
        @click=${() => {
          openCron(c, { push: true });
          startEdit(c, c.message === undefined ? "task" : "title");
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
                aria-label="Archive cron"
                @click=${() => void archiveCron(c.id, true)}
              >
                ${icon(Archive, 14)}
              </button>
            `
      }
    </div>
  `;
}

function cronPaneHost(): HTMLElement | null {
  const main = appState.mainEl;
  if (!main) return null;
  const existing = main.querySelector<HTMLElement>(":scope > .cron-detail-pane");
  if (existing) return existing;
  const host = document.createElement("div");
  host.className = "resource-pane cron-pane cron-detail-pane";
  main.replaceChildren(host);
  return host;
}

function openCron(c: CronView, opts: { push?: boolean; refreshRuns?: boolean } = {}): void {
  const switching = activeCronId !== c.id;
  const shouldRefreshRuns = opts.refreshRuns || switching;
  if (switching) clearCronDetailState();
  activeCronId = c.id;
  syncCronUrl(c.id, opts.push);
  const host = cronPaneHost();
  if (!host) return;
  const mine = cronList.some((x) => x.id === c.id);
  const manageable = canManageCron(c, mine);
  const notice = cronActionNotice?.cronId === c.id ? cronActionNotice.text : "";
  render(
    html`
      <div class="resource-detail cron-detail">
        ${listBackLink("Crons", drawCronsPage)}
        <div class="resource-heading cron-heading">
          ${cronTitleTpl(c, manageable)}
          <div class="actions">
            ${manageable && !c.archived ? cronSwitch(c) : nothing}
            ${
              manageable && c.enabled && !c.archived
                ? html`<button class="btn" @click=${() => void runCronNow(c.id)}>
                    ${icon(Play, 15)}<span>Run now</span>
                  </button>`
                : nothing
            }
            ${mine ? shareButton({ type: "cron", id: c.id, title: cronTitle(c), owner: c.ownerScopeId }) : nothing}
            ${manageable ? cronMenu(c) : nothing}
          </div>
        </div>
        <div class="cron-summary">${cronSummaryLine(c)}</div>
        ${notice ? html`<div class="action-notice">${notice}</div>` : nothing}
        ${
          c.archived
            ? html`<div class="cron-banner">
                <span>Archived. It won't run until you restore it.</span>
                ${
                  manageable
                    ? html`<button class="btn" @click=${() => void archiveCron(c.id, false)}>
                        ${icon(RotateCcw, 15)}<span>Unarchive</span>
                      </button>`
                    : nothing
                }
              </div>`
            : nothing
        }
        ${
          manageable
            ? nothing
            : html`<div class="cron-banner">Shared from ${cronScopeLabel(c)}. You can view it, but not change it.</div>`
        }
        ${cronCopyBanner(c)} ${cronInstructions(c, manageable)} ${cronScheduleSection(c, manageable)}
        ${cronSection(
          "Delivers to",
          cronDeliveryList(c, mine, mine && !c.copies ? (cronShares.get(c.id) ?? []) : [], () =>
            openShare(
              { type: "cron", id: c.id, title: cronTitle(c), owner: c.ownerScopeId },
              { onChange: () => void loadCronShares(c.id) },
            ),
          ),
        )}
        ${manageable ? cronRunHistory(c) : nothing}
        <div class="cron-details">
          ${scopeChip(c.ownerScopeId, c.scopeName ?? null)} ${mine ? nothing : html`<span>Owner ${c.owner}</span>`}
          <span>Created ${new Date(c.createdAt).toLocaleDateString()}</span>
          <span class="cron-id">${c.id}</span>
        </div>
        ${cronDialog?.cron.id === c.id ? cronDialogTpl(cronDialog) : nothing}
      </div>
    `,
    host,
  );
  if (manageable && (shouldRefreshRuns || !cronRuns.has(c.id)) && !cronRunsLoading.has(c.id)) void loadCronRuns(c.id);
  if (mine && (shouldRefreshRuns || !cronShares.has(c.id))) void loadCronShares(c.id);
}

function cronSection(title: string, body: TemplateResult, aside: TemplateResult | typeof nothing = nothing) {
  return html`<section class="cron-section">
    <div class="cron-section-head">
      <h3>${title}</h3>
      ${aside}
    </div>
    ${body}
  </section>`;
}

function editing(c: CronView, field: CronEditField): boolean {
  return cronEdit?.id === c.id && cronEdit.field === field;
}

function startEdit(c: CronView, field: CronEditField): void {
  cronActionNotice = null;
  cronEdit = { id: c.id, field };
  if (field === "schedule") scheduleDraft = draftFromSchedule(c.schedule);
  openCron(c);
  queueMicrotask(() =>
    document.querySelector<HTMLElement>(`.cron-detail [data-autofocus="${field}"]`)?.focus({ preventScroll: true }),
  );
}

function cancelEdit(c: CronView): void {
  cronActionNotice = null;
  cronEdit = null;
  scheduleDraft = null;
  openCron(c);
}

function cronTitleTpl(c: CronView, manageable: boolean): TemplateResult {
  if (editing(c, "title"))
    return html`<form
      class="cron-title-form"
      @submit=${(e: SubmitEvent) => void saveCronField(e, c, "title")}
      @keydown=${(e: KeyboardEvent) => e.key === "Escape" && cancelEdit(c)}
    >
      <input
        name="title"
        maxlength="80"
        aria-label="Title"
        data-autofocus="title"
        .value=${c.title ?? cronTitle(c)}
        required
      />
      <button class="btn" type="button" @click=${() => cancelEdit(c)}>Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </form>`;
  if (!manageable) return html`<h2 dir="auto">${cronTitle(c)}</h2>`;
  return html`<h2 class="cron-title" dir="auto">
    <button class="cron-title-button" type="button" ${tip("Rename")} @click=${() => startEdit(c, "title")}>
      <span>${cronTitle(c)}</span>${icon(Pencil, 14)}
    </button>
  </h2>`;
}

function cronCopyBanner(c: CronView): TemplateResult | typeof nothing {
  if (!c.sharedFrom) return nothing;
  const from = c.sharedBy ? friendlyPrincipal(c.sharedBy) : "a teammate";
  if (c.forkedAt || c.enabled)
    return html`<div class="cron-banner">
      <span>Shared by <strong>${from}</strong>${c.forkedAt ? " · your edited copy" : " · linked to their cron"}</span>
    </div>`;
  return html`<div class="cron-banner">
    <span><strong>${from}</strong> shared this with you. It runs as you once you turn it on.</span>
    <span class="cron-banner-actions">
      <button class="btn" type="button" @click=${() => showCronDialog("delete", c)}>Decline</button>
      <button class="btn primary" type="button" @click=${() => void setCronEnabled(c.id, true)}>Turn on</button>
    </span>
  </div>`;
}

function cronSwitch(c: CronView): TemplateResult {
  return html`<button
    class="cron-switch ${c.enabled ? "on" : ""}"
    type="button"
    role="switch"
    aria-checked=${c.enabled ? "true" : "false"}
    ${tip(c.enabled ? "Pause this cron" : "Turn this cron on")}
    @click=${() => void setCronEnabled(c.id, !c.enabled)}
  >
    <span class="cron-switch-track"><span></span></span><span>${c.enabled ? "On" : "Off"}</span>
  </button>`;
}

function cronMenu(c: CronView): TemplateResult {
  const item = (glyph: Parameters<typeof icon>[0], label: string, run: () => void, danger = false) => html`
    <button
      class="menu-option ${danger ? "danger" : ""}"
      type="button"
      role="menuitem"
      @click=${() => {
        closeFormMenus();
        run();
      }}
    >
      ${icon(glyph, 16)}<span class="menu-option-copy"><span class="menu-option-label">${label}</span></span>
    </button>
  `;
  return html`<div class="menu-control form-menu-control cron-more" data-align="right" data-drop="down">
    <button
      class="icon-btn menu-button"
      type="button"
      aria-label="More actions"
      aria-haspopup="menu"
      aria-expanded="false"
      @click=${toggleFormMenu}
    >
      ${icon(Ellipsis, 18)}
    </button>
    <div class="menu-popover" role="menu" hidden>
      ${item(Sparkles, "Change with QM…", () => editCronWithAgent(c))} ${item(Plus, "New cron", showNewCron)}
      ${
        c.archived
          ? item(RotateCcw, "Unarchive", () => void archiveCron(c.id, false))
          : item(Archive, "Archive", () => void archiveCron(c.id, true))
      }
      ${item(Trash2, "Delete…", () => showCronDialog("delete", c), true)}
    </div>
  </div>`;
}

function cronSummaryLine(c: CronView): TemplateResult {
  const next = cronNextFire(c);
  const tz = c.schedule.cron ? timezoneLabel(c.schedule.timezone) : "";
  const last = cronRuns.get(c.id)?.at(-1);
  const tone = last ? runStatusTone(last.status) : "";
  let lastMark: TemplateResult | typeof nothing = nothing;
  if (tone === "bad") lastMark = html` <span class="cron-mark bad">failed</span>`;
  if (tone === "ok") lastMark = html` <span class="cron-mark ok" aria-label="succeeded">✓</span>`;
  const parts: TemplateResult[] = [html`<strong>${describeSchedule(c.schedule)}</strong>${tz ? ` ${tz}` : ""}`];
  if (c.archived) parts.push(html`Archived`);
  else if (!c.enabled) parts.push(html`Paused`);
  else if (next != null) parts.push(html`Next ${formatCronDateTime(next, Date.now(), c.schedule.timezone)}`);
  if (c.lastFiredAt) parts.push(html`Last ran ${relTime(c.lastFiredAt)}${lastMark}`);
  return html`${parts.map((part, i) => (i ? html`<span class="cron-dot">·</span>${part}` : part))}`;
}

function cronInstructions(c: CronView, manageable: boolean): TemplateResult {
  const isMessage = c.message !== undefined;
  const title = isMessage ? "Message" : "Instructions";
  if (editing(c, "task"))
    return cronSection(
      title,
      html`<form
        class="cron-card cron-task-form"
        @submit=${(e: SubmitEvent) => void saveCronField(e, c, "task")}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape") cancelEdit(c);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget as HTMLFormElement).requestSubmit();
        }}
      >
        <textarea name="task" rows="8" aria-label="Instructions" data-autofocus="task" .value=${cronText(c)}></textarea>
        <div class="cron-card-actions">
          <button class="btn" type="button" @click=${() => cancelEdit(c)}>Cancel</button>
          <button class="btn primary" type="submit">Save</button>
        </div>
      </form>`,
    );
  const canEdit = manageable && !isMessage;
  return cronSection(
    title,
    html`<div class="cron-card">
      ${
        canEdit
          ? html`<button
              class="cron-task cron-task-button"
              type="button"
              dir="auto"
              @click=${() => startEdit(c, "task")}
            >
              <span class="cron-task-text">${cronText(c)}</span>
            </button>`
          : html`<div class="cron-task" dir="auto"><span class="cron-task-text">${cronText(c)}</span></div>`
      }
    </div>`,
    canEdit
      ? html`<button class="link-button" type="button" @click=${() => startEdit(c, "task")}>Edit</button>`
      : nothing,
  );
}

function cronScheduleSection(c: CronView, manageable: boolean): TemplateResult {
  if (editing(c, "schedule") && scheduleDraft)
    return cronSection(
      "Schedule",
      schedulePicker(scheduleDraft, {
        change: (patch) => {
          scheduleDraft = scheduleDraft && { ...scheduleDraft, ...patch };
          openCron(c);
        },
        save: (schedule) => void saveSchedule(c, schedule),
        cancel: () => cancelEdit(c),
      }),
    );
  const next = cronNextFire(c);
  const sub = [
    c.schedule.cron ? timezoneLabel(c.schedule.timezone) : "",
    next != null ? `next ${formatCronDateTime(next, Date.now(), c.schedule.timezone)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return cronSection(
    "Schedule",
    html`<div class="cron-card cron-when">
      <div>
        <div class="cron-when-main">${describeSchedule(c.schedule)}</div>
        ${sub ? html`<div class="cron-when-sub">${sub}</div>` : nothing}
      </div>
      ${
        manageable
          ? html`<button class="btn" type="button" @click=${() => startEdit(c, "schedule")}>Change</button>`
          : nothing
      }
    </div>`,
  );
}

async function loadCronShares(id: string): Promise<void> {
  try {
    const r = await api<{
      grantees: Array<{ scope: string; permission: "read" | "write" }>;
      labels?: Record<string, string>;
    }>(`/api/shares/cron/${encodeURIComponent(id)}`);
    rememberScopeLabels(r.labels);
    cronShares.set(id, r.grantees ?? []);
  } catch {
    cronShares.set(id, []);
  }
  if (activeCronId !== id || appState.currentView !== "crons") return;
  const current = cronList.find((x) => x.id === id);
  if (current) openCron(current);
}

function runStatusTone(status: string | undefined): string {
  if (status === "failed" || status === "refused") return "bad";
  if (status === "running") return "busy";
  return status === "completed" || status === undefined ? "ok" : "";
}

function cronRunHistory(c: CronView): TemplateResult {
  const runs = cronRuns.get(c.id);
  let body: TemplateResult;
  if (!runs) body = html`<div class="hint">Loading…</div>`;
  else if (!runs.length) body = html`<div class="hint">No runs yet.</div>`;
  else
    body = html`<div class="cron-card cron-run-list">
      ${[...runs].reverse().map((run) => {
        const detail = run.note ?? (run.reply ? clipWords(run.reply, 120) : "");
        return html`<div class="cron-run-row">
          <span class="cron-run-dot ${runStatusTone(run.status)}" ${tip(run.status ?? "completed")}></span>
          <span class="cron-run-time">${cronRunTiming(run)}</span>
          ${
            run.sessionId
              ? html`<a class="cron-run-link" href=${deepLinkPath(UI_BASE, "chats", run.sessionId)}>Worklog</a>`
              : nothing
          }
          ${
            detail
              ? html`<span class=${run.note ? "cron-run-detail cron-run-error" : "cron-run-detail"} ${tip(detail)}>
                  ${detail}
                </span>`
              : nothing
          }
        </div>`;
      })}
    </div>`;
  const note = c.lastFireNote
    ? html`<div class="cron-note">
        <span>${c.lastFireNote.by ? `Note from ${c.lastFireNote.by}` : "Note for the next run"}</span>
        <span dir="auto">${c.lastFireNote.text}</span>
      </div>`
    : nothing;
  return cronSection("Recent runs", html`${note}${body}`);
}

async function loadCronRuns(id: string): Promise<void> {
  cronRunsLoading.add(id);
  try {
    const result = await api<{ runs: CronRunView[] }>(`/api/crons/${encodeURIComponent(id)}/runs?limit=20`);
    cronRuns.set(id, result.runs ?? []);
  } catch (error) {
    if (appState.currentView === "crons" && activeCronId === id) {
      cronActionNotice = { cronId: id, text: errMessage(error, "Couldn't load run history.") };
    }
    cronRuns.set(id, []);
  } finally {
    cronRunsLoading.delete(id);
  }
  if (activeCronId !== id || appState.currentView !== "crons") return;
  const current =
    cronList.find((candidate) => candidate.id === id) ?? visibleCronList.find((candidate) => candidate.id === id);
  if (current) openCron(current);
}

function setCronNoticeFor(id: string, text: string): void {
  if (appState.currentView !== "crons") return;
  if (activeCronId === id) cronActionNotice = { cronId: id, text };
  else if (activeCronId === null && cronsPageHost?.isConnected) cronActionNotice = { cronId: null, text };
}

async function reopenCron(id: string, opts: { refresh?: boolean } = {}): Promise<void> {
  if (opts.refresh !== false) await refreshCrons();
  if (appState.currentView !== "crons") return;
  if (activeCronId === null) {
    if (cronsPageHost?.isConnected) drawCronsPage();
    return;
  }
  if (activeCronId !== id) return;
  const c = cronList.find((x) => x.id === id) ?? visibleCronList.find((x) => x.id === id);
  if (c) openCron(c, { refreshRuns: true });
  else drawCronsPage();
}

async function cronMutate<T>(fn: () => Promise<T>, busyValue: T): Promise<T> {
  if (cronMutationInFlight) return busyValue;
  cronMutationInFlight = true;
  try {
    return await fn();
  } finally {
    cronMutationInFlight = false;
  }
}

function runCronNow(id: string): Promise<void> {
  return cronMutate(async () => {
    cronActionNotice = null;
    try {
      await api(`/api/crons/${encodeURIComponent(id)}/run`, { method: "POST" });
      setCronNoticeFor(id, "Run started. Refresh recent runs after it completes.");
    } catch (e) {
      setCronNoticeFor(id, errMessage(e, "run failed"));
    }
    await reopenCron(id);
  }, undefined);
}

function patchCron(
  id: string,
  patch: { title?: string; task?: string; schedule?: CronView["schedule"]; enabled?: boolean; archived?: boolean },
  errorLabel: string,
): Promise<boolean> {
  return cronMutate(async () => {
    cronActionNotice = null;
    try {
      await api(`/api/crons/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return true;
    } catch (e) {
      setCronNoticeFor(id, errMessage(e, errorLabel));
      await reopenCron(id);
      return false;
    }
  }, false);
}

function showCronDialog(kind: "delete", cron: CronView): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const opener = active && active !== document.body && !active.closest("[hidden]") ? active : null;
  cronDialog = { kind, cron, opener };
  openCron(cron);
  const host = appState.mainEl?.querySelector<HTMLElement>(":scope > .cron-detail-pane");
  if (host) focusDialogCancel(host);
}

function closeCronDialog(c: CronView): void {
  const opener = cronDialog?.opener ?? null;
  cronDialog = null;
  openCron(c);
  restoreDialogFocus(opener, () => appState.mainEl?.querySelector<HTMLElement>(".cron-more .menu-button"));
}

function cronDialogTpl(dialog: { kind: "delete"; cron: CronView; opener: HTMLElement | null }): TemplateResult {
  const c = dialog.cron;
  return html` <div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeCronDialog(c)}
  >
    <div
      class="project-dialog cron-edit-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cron-delete-title"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, () => closeCronDialog(c))}
    >
      <div class="project-dialog-head">
        <div>
          <h2 id="cron-delete-title">Delete <bdi>${cronTitle(c)}</bdi>?</h2>
        </div>
      </div>
      <p>
        This permanently removes the schedule and its retained run history. Archive it instead if you may need it later.
      </p>
      <div class="project-dialog-actions">
        <button class="btn" type="button" data-dialog-cancel @click=${() => closeCronDialog(c)}>Cancel</button>
        <button class="btn danger" type="button" @click=${() => void confirmDeleteCron(c.id)}>
          Delete permanently
        </button>
      </div>
    </div>
  </div>`;
}

async function saveCronField(event: SubmitEvent, c: CronView, field: "title" | "task"): Promise<void> {
  event.preventDefault();
  const control = (event.currentTarget as HTMLFormElement).elements.namedItem(field) as
    HTMLInputElement | HTMLTextAreaElement;
  const value = control.value.trim();
  if (!value) return control.focus();
  const ok = await patchCron(c.id, { [field]: value }, `${field} update failed`);
  if (!ok) return;
  cronEdit = null;
  await reopenCron(c.id);
}

async function saveSchedule(c: CronView, schedule: { cron: string; timezone: string }): Promise<void> {
  const ok = await patchCron(c.id, { schedule }, "schedule update failed");
  if (!ok) return;
  cronEdit = null;
  scheduleDraft = null;
  await reopenCron(c.id);
}

function editCronWithAgent(c: CronView): void {
  cronDialog = null;
  const conv = startNewChat();
  void conv?.state.agent?.prompt(
    userSendMessage(
      `Help me edit cron ${c.id} ("${cronTitle(c)}"). Its current schedule is ${cronScheduleSummary(c)}. Ask what I want changed, then update its task, schedule, timezone, destination, or run mode as requested.`,
    ),
  );
}

async function archiveCron(id: string, archived: boolean): Promise<void> {
  const ok = await patchCron(id, { archived }, archived ? "archive failed" : "unarchive failed");
  if (!ok) return;
  await refreshCrons();
  if (appState.currentView !== "crons") return;
  cronTab = "yours";
  if (archived) {
    if (activeCronId === null ? cronsPageHost?.isConnected : activeCronId === id) drawCronsPage();
    return;
  }
  showDisabledCrons = true;
  await reopenCron(id, { refresh: false });
}

function setCronEnabled(id: string, enabled: boolean): Promise<void> {
  return cronMutate(async () => {
    cronActionNotice = null;
    try {
      await api(`/api/crons/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" });
      cronTab = "yours";
      if (!enabled) showDisabledCrons = true;
    } catch (e) {
      setCronNoticeFor(id, errMessage(e, enabled ? "enable failed" : "disable failed"));
    }
    await reopenCron(id);
  }, undefined);
}

async function confirmDeleteCron(id: string): Promise<void> {
  await cronMutate(async () => {
    cronDialog = null;
    cronActionNotice = null;
    try {
      await api(`/api/crons/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      setCronNoticeFor(id, errMessage(e, "delete failed"));
    }
    await reopenCron(id);
  }, undefined);
}

function cronForm() {
  return html`
    <form class="resource-form cron-form" @submit=${onCreateCron}>
      ${listBackLink("Crons", drawCronsPage)}
      <h2>New cron</h2>
      <p class="hint">
        Describe what you want scheduled: what to do, how often, and where the result should go. The agent sets it up
        and confirms in chat; it will ask if anything is unclear. It should give the cron a short, distinctive title
        naming what it is for, like <code>Gmail unread digest</code> or <code>GitLab CI watch</code>.
      </p>
      <label>
        <textarea
          name="text"
          rows="4"
          placeholder="Every weekday at 9am, summarize my unread email and DM me the highlights."
          required
        ></textarea>
      </label>
      <div class="form-error"></div>
      <div class="actions"><button class="btn primary" type="submit">Ask the agent to set it up</button></div>
    </form>
  `;
}

function showNewCron(): void {
  if (!appState.mainEl) return;
  activeCronId = null;
  clearCronDetailState();
  const host = document.createElement("div");
  host.className = "resource-pane cron-pane";
  render(cronForm(), host);
  appState.mainEl.replaceChildren(host);
}

function onCreateCron(e: Event): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const errSlot = form.querySelector(".form-error") as HTMLElement | null;
  const text = (form.querySelector('textarea[name="text"]') as HTMLTextAreaElement | null)?.value.trim() ?? "";
  if (!text) {
    if (errSlot) errSlot.textContent = "Describe the cron you want.";
    return;
  }
  const conv = startNewChat();
  void conv?.state.agent?.prompt(
    userSendMessage(
      `Set up a cron for me: ${text}\n\n(Sent from the web UI's New-cron pane: create it now with your scheduling API, use a calendar schedule with timezone for daily/weekly/monthly timing, give it a 2-5 word title naming what the cron is for and distinctive in a list, like "Gmail unread digest" or "GitLab CI watch", not the command and not a generic word, and confirm what you created.)`,
    ),
  );
}
