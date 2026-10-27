import { html, nothing, type TemplateResult } from "lit";
import { Archive, Pause, Pencil, Play, Plus, RotateCcw, Trash2, type IconNode } from "lucide";
import { api, userSendMessage } from "./core-bridge";
import {
  artifactPage,
  detailTpl,
  fieldTpl,
  iconBtn,
  listBackLink,
  listPageTpl,
  ownershipTabs,
  showPane,
  textBtn,
  type OwnershipTab,
} from "./list-page";
import { scopeChip } from "./contexts";
import { appState } from "./shell";
import { startNewChat } from "./sessions";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { cronNextFire, cronRunSummary, cronScheduleDetail, cronScheduleSummary } from "./cron-format";
import { tip } from "./tooltip";
import { confirmDialogTpl } from "./dialog-focus";

interface CronView {
  id: string;
  ownerScopeId: string;
  owner: string;
  title?: string;
  action?: string;
  message?: string;
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
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

interface CronRunView {
  firedAt: number;
  status?: string;
  endedAt?: number;
  note?: string;
  reply?: string;
  sessionId?: string;
}

function cronRunTiming(run: CronRunView): string {
  const fired = new Date(run.firedAt).toLocaleString();
  if (run.status === "running")
    return `${fired} — in flight for ${Math.max(0, Math.round((Date.now() - run.firedAt) / 60_000))}m`;
  if (run.endedAt === undefined) return fired;
  return `${fired} — took ${Math.max(0, Math.round((run.endedAt - run.firedAt) / 1000))}s`;
}

let cronList: CronView[] = [];
let visibleCronList: CronView[] = [];
let cronTab: OwnershipTab = "yours";
let showDisabledCrons = false;
let cronMutationInFlight = false;
const cronRuns = new Map<string, CronRunView[]>();
const cronRunsLoading = new Set<string>();
let cronDialog: { kind: "rename" | "delete"; cron: CronView } | null = null;
let activeCronId: string | null = null;
const page = artifactPage("crons", "crons-page", "crons");

export function openCronById(id: string): void {
  page.pending = id;
}

function findCron(id: string): CronView | undefined {
  return cronList.find((c) => c.id === id) ?? visibleCronList.find((c) => c.id === id);
}

export function routeCronsHistory(cronId: string | null): void {
  page.route(cronId, findCron, openCron, drawCronsPage);
}

function refreshCrons(showLoading = false): Promise<boolean> {
  return page.refresh(
    async () => {
      const r = await api<{ crons: CronView[]; visible?: CronView[] }>("/api/crons");
      cronList = r.crons ?? [];
      visibleCronList = r.visible ?? [];
    },
    "Failed to load crons.",
    showLoading,
  );
}

function cronText(c: CronView): string {
  return c.message ?? c.action ?? "";
}

function clipWords(text: string, max = 64): string {
  const clean = text
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const wordCut = cut.replace(/\s+\S*$/, "");
  return `${(wordCut.length >= max * 0.55 ? wordCut : cut).trim()}…`;
}

function cronTitle(c: CronView): string {
  return c.title?.trim() || clipWords(cronText(c), 58) || "(untitled cron)";
}

function cronScopeLabel(c: CronView): string | undefined {
  const kind = c.ownerScopeId.split(":", 1)[0]!;
  if (kind === "channel") return c.scopeName ? `#${c.scopeName}` : "a Slack channel";
  if (kind === "org") return "org-wide";
  return kind === "group" ? "group" : undefined;
}

function cronStatus(c: CronView): "Enabled" | "Disabled" | "Archived" {
  if (c.archived) return "Archived";
  return c.enabled ? "Enabled" : "Disabled";
}

export async function renderCronsPage(): Promise<void> {
  await page.show({
    load: () => refreshCrons(cronList.length === 0 && visibleCronList.length === 0),
    find: findCron,
    open: openCron,
    draw: drawCronsPage,
    missing: "That cron wasn't found, or you don't have access to it.",
  });
}

function drawCronsPage(): void {
  activeCronId = null;
  page.syncUrl(null);
  const all = [...cronList.map((c) => ({ c, mine: true })), ...visibleCronList.map((c) => ({ c, mine: false }))]
    .filter(
      ({ c }) => page.inScope(c.ownerScopeId) && page.matches(`${cronTitle(c)} ${cronText(c)} ${c.scopeName ?? ""}`),
    )
    .sort((a, b) => b.c.createdAt - a.c.createdAt);
  const archived = all.filter(({ c }) => c.archived);
  const yours = all.filter(({ c, mine }) => mine && !c.archived);
  const yoursEnabled = yours.filter(({ c }) => c.enabled);
  const yoursDisabled = yours.filter(({ c }) => !c.enabled);
  const shared = all.filter(({ c, mine }) => !mine && !c.archived);
  const ownsAny = all.some(({ mine }) => mine);
  const counts = {
    yours: yoursEnabled.length,
    shared: shared.filter(({ c }) => c.enabled).length,
    archived: archived.length,
  };

  const rows = page.flashRows();
  const empty = (text: string) => html`<div class="empty compact cron-filter-empty">${text}</div>`;
  if (all.length)
    rows.push(
      ownershipTabs(
        "Cron view",
        counts,
        cronTab,
        (tab) => {
          cronTab = tab;
          drawCronsPage();
        },
        (t) => t === "shared" && shared.length > 0,
      ),
    );
  if (cronTab === "yours") {
    rows.push(...yoursEnabled.map(cronPageRow));
    if (all.length && !yoursEnabled.length)
      rows.push(empty(ownsAny ? "No active crons." : "None of your own crons yet."));
    if (yoursDisabled.length) {
      rows.push(html`
        <button
          class="archived-toggle cron-disabled-toggle"
          type="button"
          @click=${() => {
            showDisabledCrons = !showDisabledCrons;
            drawCronsPage();
          }}
        >
          <span>${showDisabledCrons ? "Hide disabled" : "Show disabled"}</span>
          <span class="archived-count">${yoursDisabled.length}</span>
        </button>
      `);
      if (showDisabledCrons) rows.push(...yoursDisabled.map(cronPageRow));
    }
  } else {
    const list = cronTab === "shared" ? shared : archived;
    rows.push(...list.map(cronPageRow));
    if (!list.length) rows.push(empty(cronTab === "shared" ? "No crons shared with you." : "Nothing archived."));
  }
  page.paint(
    listPageTpl({
      title: "Crons",
      search: page.search("Search crons", drawCronsPage),
      rows,
      empty: page.emptyText("crons", cronList.length === 0 && visibleCronList.length === 0),
    }),
    drawCronsPage,
  );
}

function canManageCron(c: CronView, mine: boolean): boolean {
  return c.permission ? c.permission === "manage" : mine;
}

function cronPageRow({ c, mine }: { c: CronView; mine: boolean }): TemplateResult {
  const run = cronRunSummary(c);
  return html`
    <div class="list-row cron-row cron-${cronStatus(c).toLowerCase()}">
      ${page.link(
        c.id,
        "cron-row-main",
        () => openCron(c, { push: true }),
        html`<span class="list-row-title cron-title-line"><span dir="auto">${cronTitle(c)}</span></span>
          <span class="list-row-meta">
            ${cronScopeLabel(c) === undefined ? nothing : scopeChip(c.ownerScopeId, c.scopeName ?? null)}
            <span class="cron-meta-line" ${tip(run.title)}>${run.text}</span>
          </span>`,
      )}
      ${
        canManageCron(c, mine)
          ? html`<div class="cron-row-actions" aria-label="Cron actions">
              ${cronActions(c, true).map(([label, node, onClick]) =>
                iconBtn(label, node, onClick, { aria: `${label} cron`, cls: "icon-btn subtle compact" }),
              )}
            </div>`
          : nothing
      }
    </div>
  `;
}

type CronAction = [string, IconNode, () => void];

function cronActions(c: CronView, row: boolean): CronAction[] {
  const edit: CronAction = ["Edit", Pencil, () => showCronDialog("rename", c)];
  const archive: CronAction = ["Archive", Archive, () => void archiveCron(c.id, true)];
  if (c.archived) return [edit, ["Unarchive", RotateCcw, () => void archiveCron(c.id, false)]];
  if (!c.enabled) return [edit, ["Enable", Play, () => void setCronEnabled(c.id, true)], archive];
  const ok = "Run started. Refresh recent runs after it completes.";
  const run: CronAction = [
    "Run now",
    Play,
    () => void cronCall(c.id, "/run", { method: "POST" }, "run failed", { ok }),
  ];
  return [edit, ...(row ? [] : [run]), ["Disable", Pause, () => void setCronEnabled(c.id, false)], archive];
}

function openCron(c: CronView, opts: { push?: boolean; refreshRuns?: boolean } = {}): void {
  const shouldRefreshRuns = opts.refreshRuns || activeCronId !== c.id;
  activeCronId = c.id;
  page.syncUrl(c.id, opts.push);
  const mine = cronList.some((x) => x.id === c.id);
  const manageable = canManageCron(c, mine);
  const next = cronNextFire(c);
  showPane(
    "cron-pane",
    detailTpl({
      back: "Crons",
      onBack: drawCronsPage,
      title: cronTitle(c),
      heading: textBtn("New cron", Plus, showNewCron),
      notice: page.takeFlash(),
      body: html`
        ${fieldTpl("Context", scopeChip(c.ownerScopeId, c.scopeName ?? null))}
        ${c.title ? fieldTpl("Title", c.title) : nothing}
        ${fieldTpl(c.message !== undefined ? "Message" : "Task", cronText(c), "pre")}
        ${fieldTpl("Schedule", cronScheduleDetail(c))} ${mine ? nothing : fieldTpl("Owner", c.owner)}
        ${mine ? nothing : fieldTpl("Scope", cronScopeLabel(c) ?? c.owner)} ${fieldTpl("Status", cronStatus(c))}
        ${c.destination ? fieldTpl("Destination", `${c.destination.type} → ${c.destination.target}`) : nothing}
        ${fieldTpl("Next run", next != null ? new Date(next).toLocaleString() : "Never")}
        ${fieldTpl("Last fired", c.lastFiredAt ? new Date(c.lastFiredAt).toLocaleString() : "Never")}
        ${
          c.lastFireNote
            ? fieldTpl(
                `${c.lastFireNote.by ? `Note left by ${c.lastFireNote.by}` : "Note from last fire"} (${new Date(c.lastFireNote.at).toLocaleString()})`,
                c.lastFireNote.text,
              )
            : nothing
        }
        ${manageable ? cronRunHistory(c) : nothing}
        ${
          manageable
            ? html`
                <div class="actions">
                  ${cronActions(c, false).map(([label, node, onClick]) => textBtn(label, node, onClick))}
                  ${textBtn("Delete", Trash2, () => showCronDialog("delete", c), "btn danger")}
                </div>
              `
            : html`<div class="hint">
                Shared from ${cronScopeLabel(c) ?? c.owner}. You can view it, but not change it.
              </div>`
        }
        ${cronDialog?.cron.id === c.id ? cronDialogTpl(cronDialog) : nothing}
      `,
    }),
  );
  if (manageable && (shouldRefreshRuns || !cronRuns.has(c.id)) && !cronRunsLoading.has(c.id)) void loadCronRuns(c.id);
}

function cronRunHistory(c: CronView): TemplateResult {
  const runs = cronRuns.get(c.id);
  let body = html`<div class="hint">${runs ? "No runs yet." : "Loading…"}</div>`;
  if (runs?.length)
    body = html`<div class="cron-run-list">
      ${[...runs].reverse().map((run) => {
        const detail = run.note ?? (run.reply ? clipWords(run.reply, 120) : "");
        return html` <div class="cron-run-row">
          <span class="badge">${run.status ?? "completed"}</span>
          <span class="cron-run-time">${cronRunTiming(run)}</span>
          <span class=${run.note ? "cron-run-detail cron-run-error" : "cron-run-detail"} ${tip(detail)}>
            ${detail}
          </span>
          ${
            run.sessionId
              ? html`<a class="cron-run-link" href=${deepLinkPath(UI_BASE, "chats", run.sessionId)}>Worklog</a>`
              : nothing
          }
        </div>`;
      })}
    </div>`;
  return html`<div class="field">
    <div class="cron-run-heading">
      <label>Recent runs</label>
    </div>
    ${body}
  </div>`;
}

async function loadCronRuns(id: string): Promise<void> {
  cronRunsLoading.add(id);
  let runs: CronRunView[] = [];
  await page.attempt(async () => {
    runs = (await api<{ runs: CronRunView[] }>(`/api/crons/${encodeURIComponent(id)}/runs`)).runs ?? [];
  }, "Couldn't load run history.");
  cronRuns.set(id, runs);
  cronRunsLoading.delete(id);
  if (activeCronId !== id || appState.currentView !== "crons") return;
  const current = findCron(id);
  if (current) openCron(current);
}

async function reopenCron(id: string): Promise<void> {
  await refreshCrons();
  page.route(id, findCron, (c) => openCron(c, { refreshRuns: true }), drawCronsPage);
}

async function cronCall(
  id: string,
  path: string,
  init: RequestInit,
  failure: string,
  o: { ok?: string; done?: (ok: boolean) => unknown } = {},
): Promise<boolean> {
  if (cronMutationInFlight) return false;
  cronMutationInFlight = true;
  try {
    const ok = await page.attempt(() => api(`/api/crons/${encodeURIComponent(id)}${path}`, init), failure, o.ok);
    await (o.done ? o.done(ok) : reopenCron(id));
    return ok;
  } finally {
    cronMutationInFlight = false;
  }
}

function showCronDialog(kind: "rename" | "delete", cron: CronView): void {
  cronDialog = { kind, cron };
  openCron(cron);
  queueMicrotask(() => document.querySelector<HTMLInputElement>(".cron-edit-dialog input")?.focus());
}

function closeCronDialog(c: CronView): void {
  cronDialog = null;
  openCron(c);
}

function cronDialogTpl(dialog: { kind: "rename" | "delete"; cron: CronView }): TemplateResult {
  const c = dialog.cron;
  if (dialog.kind === "delete")
    return confirmDialogTpl({
      id: "cron-delete",
      title: html`Delete <bdi>${cronTitle(c)}</bdi>?`,
      body: "This permanently removes the schedule and its retained run history. Archive it instead if you may need it later.",
      confirm: "Delete permanently",
      onCancel: () => closeCronDialog(c),
      onConfirm: () => {
        cronDialog = null;
        void cronCall(c.id, "", { method: "DELETE" }, "delete failed");
      },
    });
  return html` <div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeCronDialog(c)}
  >
    <form
      class="project-dialog cron-edit-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cron-edit-title"
      @submit=${(event: SubmitEvent) => void saveCronEdit(event, c)}
    >
      <div class="project-dialog-head">
        <div><h2 id="cron-edit-title">Edit cron</h2></div>
      </div>
      <label>Title<input name="title" maxlength="80" value=${c.title ?? cronTitle(c)} required /></label>
      ${
        c.message === undefined
          ? html`<label>Task<textarea name="task" rows="5" required>${cronText(c)}</textarea></label>`
          : html`<div class="field">
              <label>Message</label>
              <div class="value pre">${c.message}</div>
            </div>`
      }
      <p class="hint">
        To change
        ${c.message === undefined ? "the schedule, timezone, destination, or run mode" : "the message, schedule, timezone, destination, or run mode"},
        use the agent so it can validate the resulting behavior and permissions.
      </p>
      <div class="form-error"></div>
      <div class="project-dialog-actions">
        <button class="btn" type="button" @click=${() => editCronWithAgent(c)}>Edit behavior with agent</button>
        <button class="btn" type="button" @click=${() => closeCronDialog(c)}>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}

async function saveCronEdit(event: SubmitEvent, c: CronView): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const title = (form.elements.namedItem("title") as HTMLInputElement).value.trim();
  const taskControl = form.elements.namedItem("task") as HTMLTextAreaElement | null;
  const task = taskControl?.value.trim();
  const error = form.querySelector<HTMLElement>(".form-error");
  if (!title || (taskControl && !task)) {
    if (error) error.textContent = taskControl ? "Title and task are required." : "Title is required.";
    return;
  }
  const body = JSON.stringify({ title, ...(task ? { task } : {}) });
  await cronCall(c.id, "", { method: "PATCH", body }, "edit failed", {
    ok: "Cron updated.",
    done: (ok) => {
      if (ok) cronDialog = null;
      return reopenCron(c.id);
    },
  });
}

function askAgent(text: string): void {
  void startNewChat()?.state.agent?.prompt(userSendMessage(text));
}

function editCronWithAgent(c: CronView): void {
  cronDialog = null;
  askAgent(
    `Help me edit cron ${c.id} ("${cronTitle(c)}"). Its current schedule is ${cronScheduleSummary(c)}. Ask what I want changed, then update its task, schedule, timezone, destination, or run mode as requested.`,
  );
}

function archiveCron(id: string, archived: boolean): Promise<boolean> {
  const body = JSON.stringify({ archived });
  return cronCall(id, "", { method: "PATCH", body }, archived ? "archive failed" : "unarchive failed", {
    done: async (ok) => {
      if (ok) cronTab = "yours";
      if (ok && archived) return refreshCrons().then(drawCronsPage);
      if (ok) showDisabledCrons = true;
      return reopenCron(id);
    },
  });
}

function setCronEnabled(id: string, enabled: boolean): Promise<boolean> {
  const verb = enabled ? "enable" : "disable";
  return cronCall(id, `/${verb}`, { method: "POST" }, `${verb} failed`, {
    done: (ok) => {
      if (ok) cronTab = "yours";
      if (ok && !enabled) showDisabledCrons = true;
      return reopenCron(id);
    },
  });
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
  activeCronId = null;
  showPane("cron-pane", cronForm());
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
  askAgent(
    `Set up a cron for me: ${text}\n\n(Sent from the web UI's New-cron pane: create it now with your scheduling API, use a calendar schedule with timezone for daily/weekly/monthly timing, give it a 2-5 word title naming what the cron is for and distinctive in a list, like "Gmail unread digest" or "GitLab CI watch", not the command and not a generic word, and confirm what you created.)`,
  );
}
