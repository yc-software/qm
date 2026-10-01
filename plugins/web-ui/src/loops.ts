import { LOOP_ICONS, loopIcon, readLoopIcon } from "./loop-icon";
import { html, nothing, render, type TemplateResult } from "lit";
import { CheckCircle2, ChevronDown, ChevronRight, CornerUpLeft, Pause, Play, Zap } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { appState, can } from "./shell";
import { tip } from "./tooltip";

interface LoopView {
  id: string;
  name: string;
  icon?: string;
  purpose?: string;
  playbook: string;
  playbookVersion: number;
  successCondition: string;
  shipActions: Array<{ action: string; gate: "auto" | "hold" }>;
  state: "enabled" | "paused" | "quarantined" | "archived";
  health: "healthy" | "degraded" | "failing" | "quarantined";
  healthReason?: string;
  owner: string;
  cronId?: string;
  sources?: string[];
  lastFiredAt?: number;
  consecutiveFailedFires?: number;
  triage?: Partial<Record<TriageKind, { enabled: boolean; instructions?: string }>>;
}

type TriageKind = "prioritize" | "consolidate";

interface TriagePreviewView {
  id: string;
  priority?: string;
  reason?: string;
  groupId?: string;
}

interface LoopItemView {
  id: string;
  sourceKey: string;
  sourceSummary?: string;
  status: string;
  attempts: number;
  parkedReason?: string;
  guidance?: string;
  updatedAt: number;
  createdAt?: number;
  sourcePayload?: { title?: string; from?: string; snippet?: string };
  triage?: { priority?: string; reason?: string; groupId?: string; pinned?: string[] };
}

interface LoopOutputView {
  id: string;
  itemId: string;
  shipAction: string;
  label?: string;
  externalRef?: string;
  title: string;
  summary?: string;
  state: "ready" | "unconfirmed" | "shipped" | "returned" | "expired";
  decidedBy?: string;
  decisionNote?: string;
  createdAt: number;
}

interface LoopDetail {
  loop: LoopView;
  items: LoopItemView[];
  outputs: LoopOutputView[];
  vitals: { queue: { queued: number; inProgress: number }; openOutputs: number };
  triageAvailable?: boolean;
}

interface IngestionSource {
  id: string;
  kind: "webhook" | "slack" | "gmail";
  enabled: boolean;
  url: string;
  channels?: string[];
  gmail?: { email: string; expiresAt: number };
  lastReceivedAt?: number;
  lastError?: string;
}
let ingestion: { sources: IngestionSource[]; gmailAvailable: boolean } | null = null;
let ingestionKind: IngestionSource["kind"] | "" = "";
let ingestionSecret = "";
let ingestionTeam = "";
let ingestionChannels = "";
let createdSecret = "";

let loopList: LoopView[] = [];
let loopsHost: HTMLElement | null = null;
let loopsLoading = false;
let loopsNotice = "";
let activeLoopId: string | null = null;
let activeDetail: LoopDetail | null = null;
let loopBusy = false;
let iconPickerOpen = false;
let playbookDraft: string | null = null;
let returnDrafts = new Map<string, string>();
let triageDrafts = new Map<TriageKind, string>();
let triagePreview: TriagePreviewView[] | "running" | null = null;
let triageEditing: TriageKind | null = null;
const expandedGroups = new Set<string>();

export function resetActiveLoop(): void {
  activeLoopId = null;
  iconPickerOpen = false;
  ingestion = null;
  ingestionKind = "";
  createdSecret = "";
  ingestionSecret = "";
  activeDetail = null;
  playbookDraft = null;
  returnDrafts = new Map();
  triageDrafts = new Map();
  triagePreview = null;
  triageEditing = null;
  expandedGroups.clear();
}

function healthBadge(loop: LoopView): TemplateResult {
  const label = loop.state === "enabled" ? loop.health : loop.state;
  return html`<span class="loop-health loop-health-${label}" title=${loop.healthReason ?? ""}>${label}</span>`;
}

function ago(ts?: number): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function refreshLoops(): Promise<void> {
  loopsLoading = true;
  paint();
  try {
    const r = await api<{ loops: LoopView[] }>("/api/loops");
    loopList = r.loops ?? [];
    loopsNotice = "";
  } catch (e) {
    loopsNotice = errMessage(e);
  } finally {
    loopsLoading = false;
    paint();
  }
}

async function refreshDetail(id: string): Promise<void> {
  try {
    const [detail, sources] = await Promise.all([
      api<LoopDetail>(`/api/loops/${encodeURIComponent(id)}`),
      api<NonNullable<typeof ingestion>>(`/api/loops/${encodeURIComponent(id)}/ingestion`),
    ]);
    activeDetail = detail;
    ingestion = sources;
    loopsNotice = "";
  } catch (e) {
    loopsNotice = errMessage(e);
  }
  paint();
}

async function mutate(fn: () => Promise<unknown>): Promise<void> {
  if (loopBusy) return;
  loopBusy = true;
  paint();
  let failure = "";
  try {
    await fn();
    loopsNotice = "";
  } catch (e) {
    failure = errMessage(e);
  } finally {
    loopBusy = false;
    if (activeLoopId) await refreshDetail(activeLoopId);
    else await refreshLoops();
    if (failure) {
      loopsNotice = failure;
      paint();
    }
  }
}

async function setLoopIcon(loop: LoopView, value: string | null | File): Promise<void> {
  await mutate(async () => {
    const icon = value instanceof File ? await readLoopIcon(value) : value;
    await api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ icon }) });
    iconPickerOpen = false;
    const { refreshInbox } = await import("./inbox");
    await refreshInbox({ silent: true });
  });
  loopsHost?.querySelector<HTMLElement>(".loop-icon-picker summary")?.focus();
}

export function openLoop(id: string): void {
  resetActiveLoop();
  activeLoopId = id;
  activeDetail = null;
  playbookDraft = null;
  void refreshDetail(id);
  paint();
}

function setState(loop: LoopView, state: LoopView["state"]): void {
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ state }) }),
  );
}

function fireNow(loop: LoopView): void {
  void mutate(() => api(`/api/loops/${encodeURIComponent(loop.id)}/fire`, { method: "POST" }));
}

function setAutopilot(loop: LoopView, enabled: boolean): void {
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}/autopilot`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  );
}

function decide(loop: LoopView, output: LoopOutputView, decision: "ship" | "return"): void {
  const note = returnDrafts.get(output.id)?.trim();
  if (decision === "return" && !note) {
    loopsNotice = "a return needs a note for the next attempt";
    paint();
    return;
  }
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}/outputs/${encodeURIComponent(output.id)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    }),
  );
  returnDrafts.delete(output.id);
}

function savePlaybook(loop: LoopView): void {
  const draft = playbookDraft?.trim();
  if (!draft || draft === loop.playbook) {
    playbookDraft = null;
    paint();
    return;
  }
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ playbook: draft }) }),
  );
  playbookDraft = null;
}

function reviewRow(loop: LoopView, output: LoopOutputView, shipLabel = "Ship"): TemplateResult {
  const externalUrl = output.externalRef && /^https?:\/\//i.test(output.externalRef) ? output.externalRef : undefined;
  return html`
    <div class="loop-output">
      <div class="loop-output-main">
        <span class="loop-output-action">${output.shipAction}${output.label ? html` · ${output.label}` : nothing}</span>
        <span class="loop-output-title">
          ${
            externalUrl
              ? html`<a href=${externalUrl} target="_blank" rel="noopener noreferrer">${output.title}</a>`
              : output.title
          }
        </span>
        ${output.summary ? html`<span class="loop-output-summary">${output.summary}</span>` : nothing}
      </div>
      <div class="loop-output-decide">
        <input
          type="text"
          placeholder="return note…"
          .value=${returnDrafts.get(output.id) ?? ""}
          @input=${(e: Event) => returnDrafts.set(output.id, (e.target as HTMLInputElement).value)}
        />
        <button class="btn" type="button" ?disabled=${loopBusy} @click=${() => decide(loop, output, "return")}>
          ${icon(CornerUpLeft, 14)}<span>Return</span>
        </button>
        <button class="btn primary" type="button" ?disabled=${loopBusy} @click=${() => decide(loop, output, "ship")}>
          ${icon(CheckCircle2, 14)}<span>${shipLabel}</span>
        </button>
      </div>
    </div>
  `;
}

const TRIAGE_COPY: Record<TriageKind, { label: string; sublabel: string; placeholder: string }> = {
  prioritize: {
    label: "Prioritize",
    sublabel: "Sort new items by urgency, with a reason on each",
    placeholder: "e.g. Production incidents and possible outages first, then customer friction.",
  },
  consolidate: {
    label: "Consolidate",
    sublabel: "Group items that one piece of work would resolve",
    placeholder: "e.g. Group Sentry errors that share a root cause.",
  },
};

function saveTriage(loop: LoopView, kind: TriageKind, enabled: boolean): void {
  const instructions = triageDrafts.get(kind) ?? loop.triage?.[kind]?.instructions ?? "";
  void mutate(async () => {
    await api(`/api/loops/${encodeURIComponent(loop.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ triage: { [kind]: { enabled, instructions } } }),
    });
    triageDrafts.delete(kind);
  });
}

function draftTriage(loop: LoopView, kind: TriageKind): Record<TriageKind, { enabled: boolean; instructions: string }> {
  const draft = (k: TriageKind) => ({
    enabled: k === kind || loop.triage?.[k]?.enabled === true,
    instructions: triageDrafts.get(k) ?? loop.triage?.[k]?.instructions ?? "",
  });
  return { prioritize: draft("prioritize"), consolidate: draft("consolidate") };
}

async function runTriagePreview(loop: LoopView, kind: TriageKind): Promise<void> {
  if (triagePreview === "running") return;
  triagePreview = "running";
  paint();
  try {
    const out = await api<{ items: TriagePreviewView[] }>(`/api/loops/${encodeURIComponent(loop.id)}/triage/preview`, {
      method: "POST",
      body: JSON.stringify({ triage: draftTriage(loop, kind) }),
    });
    triagePreview = out.items;
  } catch (e) {
    triagePreview = null;
    loopsNotice = `Dry run failed: ${errMessage(e)}`;
  }
  paint();
}

const PREVIEW_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const rank = (priority?: string): number => PREVIEW_RANK[priority ?? "normal"] ?? 2;

function openTriageEditor(kind: TriageKind): void {
  triageEditing = kind;
  triagePreview = null;
  paint();
  queueMicrotask(() => {
    const dialog = document.querySelector<HTMLDialogElement>(".loop-triage-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  });
}

function closeTriageEditor(): void {
  if (triageEditing) triageDrafts.delete(triageEditing);
  triageEditing = null;
  triagePreview = null;
  paint();
}

function priorityCell(priority: string | undefined, reason: string | undefined, was?: string): TemplateResult {
  const label = (p: string) => `${p[0]!.toUpperCase()}${p.slice(1)}`;
  return html`<span class="loop-triage-col">
    ${priority ? html`<span class="inbox-priority inbox-priority-${priority}" ${reason ? tip(reason) : nothing}>${label(priority)}</span>` : html`<span class="loop-triage-none">—</span>`}
    ${was !== undefined && was !== priority ? html`<span class="loop-triage-was">was ${was ? label(was) : "—"}</span>` : nothing}
  </span>`;
}

function itemKey(item: LoopItemView): string {
  return item.sourcePayload?.from ?? item.sourceKey.split(":").pop() ?? item.sourceKey;
}

function itemText(item: LoopItemView): string {
  return item.sourcePayload?.snippet || item.sourcePayload?.title || item.sourceSummary || item.sourceKey;
}

function editorRows(kind: TriageKind, items: LoopItemView[]): TemplateResult {
  const preview = Array.isArray(triagePreview) ? new Map(triagePreview.map((entry) => [entry.id, entry])) : null;
  const open = items.filter((item) => item.status !== "shipped" && item.status !== "skipped");
  const scored = (preview ? open.filter((item) => preview.has(item.id)) : open).map((item) => {
    const next = preview?.get(item.id);
    return {
      item,
      priority: preview ? next?.priority : item.triage?.priority,
      reason: preview ? next?.reason : item.triage?.reason,
      groupId: preview ? next?.groupId : item.triage?.groupId,
      was: preview ? (item.triage?.priority ?? "") : undefined,
    };
  });
  const row = (entry: (typeof scored)[number]) =>
    html`<li>
      <span class="inbox-subject-key">${itemKey(entry.item)}</span>
      <span class="inbox-subject-text" title=${itemText(entry.item)}>${itemText(entry.item)}</span>
      ${priorityCell(entry.priority, entry.reason, entry.was)}
    </li>`;
  if (kind === "prioritize")
    return html`<ul>
      ${[...scored].sort((a, b) => rank(a.priority) - rank(b.priority)).map(row)}
    </ul>`;
  const groups = new Map<string, typeof scored>();
  for (const entry of scored) {
    const key = entry.groupId ?? entry.item.id;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => b.length - a.length || rank(a[0]!.priority) - rank(b[0]!.priority),
  );
  return html`${ordered.map(
    (group) =>
      html`<div class="loop-triage-group ${group.length > 1 ? "multi" : ""}">
        ${group.length > 1 ? html`<div class="inbox-subject-label">${group.length} similar</div>` : nothing}
        <ul>
          ${group.map(row)}
        </ul>
      </div>`,
  )}`;
}

function triageStatus(
  kind: TriageKind,
  items: LoopItemView[],
  running: boolean,
  preview: TriagePreviewView[] | null,
): string {
  if (running) return "Running a dry run on open items…";
  if (!preview) return kind === "prioritize" ? "Current priorities" : "Current groups";
  if (kind === "consolidate") {
    const rows = new Set(preview.map((entry) => entry.groupId ?? entry.id)).size;
    return `Dry run · ${preview.length} items into ${rows} rows · nothing saved`;
  }
  const before = new Map(items.map((item) => [item.id, item.triage?.priority ?? ""]));
  const changed = preview.filter((entry) => (entry.priority ?? "") !== before.get(entry.id)).length;
  return `Dry run · ${preview.length} items rescored · ${changed} changed · nothing saved`;
}

function triageEditorTpl(loop: LoopView, items: LoopItemView[]): TemplateResult | typeof nothing {
  const kind = triageEditing;
  if (!kind) return nothing;
  const copy = TRIAGE_COPY[kind];
  const saved = loop.triage?.[kind]?.instructions ?? "";
  const draft = triageDrafts.get(kind) ?? saved;
  const running = triagePreview === "running";
  const preview = Array.isArray(triagePreview) ? triagePreview : null;
  const status = triageStatus(kind, items, running, preview);
  return html`<dialog
    class="project-dialog loop-triage-dialog"
    aria-labelledby="loop-triage-dialog-title"
    @close=${closeTriageEditor}
    @click=${(event: MouseEvent) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
  >
    <div class="project-dialog-head">
      <div><h2 id="loop-triage-dialog-title">${copy.label}</h2></div>
    </div>
    <textarea
      class="loop-playbook loop-triage-instructions"
      rows="4"
      aria-label=${`${copy.label} instructions`}
      placeholder=${copy.placeholder}
      .value=${draft}
      @input=${(e: Event) => {
        triageDrafts.set(kind, (e.target as HTMLTextAreaElement).value);
        paint();
      }}
    ></textarea>
    <div class="loop-triage-dialog-bar">
      <span class="loop-triage-dialog-status" role="status">${status}</span>
      <button class="btn" type="button" ?disabled=${running} @click=${() => void runTriagePreview(loop, kind)}>
        Dry run
      </button>
    </div>
    <section class="inbox-subject loop-triage-list ${running ? "running" : ""}">${editorRows(kind, items)}</section>
    <div class="project-dialog-actions">
      <button
        class="btn"
        type="button"
        @click=${() => document.querySelector<HTMLDialogElement>(".loop-triage-dialog")?.close()}
      >
        Cancel
      </button>
      <button
        class="btn primary"
        type="button"
        ?disabled=${loopBusy || draft === saved}
        @click=${() => {
          saveTriage(loop, kind, true);
          document.querySelector<HTMLDialogElement>(".loop-triage-dialog")?.close();
        }}
      >
        Save
      </button>
    </div>
  </dialog>`;
}

function triageTpl(loop: LoopView, items: LoopItemView[]): TemplateResult {
  return html`<h2 class="loop-section-title">Triage</h2>
    <div class="loop-triage">
      ${(Object.keys(TRIAGE_COPY) as TriageKind[]).map((kind) => {
        const setting = loop.triage?.[kind];
        const enabled = setting?.enabled === true;
        const copy = TRIAGE_COPY[kind];
        return html`<div class="loop-triage-setting">
          <button
            class="loop-autopilot ${enabled ? "on" : ""}"
            type="button"
            role="switch"
            aria-checked=${enabled ? "true" : "false"}
            ?disabled=${loopBusy}
            @click=${() => saveTriage(loop, kind, !enabled)}
          >
            <span class="loop-autopilot-copy">
              <span class="loop-autopilot-label">${copy.label}</span>
              <span class="loop-autopilot-sublabel">${copy.sublabel}</span>
            </span>
            <span class="loop-autopilot-switch"><span></span></span>
          </button>
          ${
            enabled
              ? html`<button
                  class="loop-triage-prompt"
                  type="button"
                  aria-label=${`Edit ${copy.label} instructions`}
                  ${tip("Edit and dry run")}
                  @click=${() => openTriageEditor(kind)}
                >
                  ${setting?.instructions || html`<span class="loop-triage-none">Default instructions</span>`}
                </button>`
              : nothing
          }
        </div>`;
      })}
    </div>
    ${triageEditorTpl(loop, items)}`;
}

function ledgerRows(loop: LoopView, items: LoopItemView[]): TemplateResult[] {
  const members = new Map<string, LoopItemView[]>();
  const grouped = loop.triage?.consolidate?.enabled === true;
  for (const item of items)
    if (grouped && item.triage?.groupId)
      members.set(item.triage.groupId, [...(members.get(item.triage.groupId) ?? []), item]);
  const rows: TemplateResult[] = [];
  for (const item of items) {
    const groupId = item.triage?.groupId;
    const group = groupId ? (members.get(groupId) ?? []) : [];
    const head = group.find((member) => member.id === groupId);
    if (!groupId || group.length < 2 || !head || head.status === "shipped" || head.status === "skipped") {
      rows.push(itemRow(loop, item));
      continue;
    }
    if (group[0] !== item) continue;
    const open = expandedGroups.has(groupId);
    rows.push(
      html`<button
        class="loop-item loop-item-group"
        type="button"
        aria-expanded=${String(open)}
        @click=${() => {
          if (open) expandedGroups.delete(groupId);
          else expandedGroups.add(groupId);
          paint();
        }}
      >
        ${icon(open ? ChevronDown : ChevronRight, 13)}
        <span class="loop-item-key">${group.length} similar ·</span>
        <span class="loop-item-summary">${head.sourceSummary ?? head.sourceKey}</span>
        ${priorityTpl(loop, head)}
      </button>`,
    );
    if (open) rows.push(...group.map((member) => itemRow(loop, member, true)));
  }
  return rows;
}

function priorityTpl(loop: LoopView, item: LoopItemView): TemplateResult | typeof nothing {
  const priority = item.triage?.priority;
  if (loop.triage?.prioritize?.enabled !== true || (priority !== "urgent" && priority !== "high")) return nothing;
  const reason = item.triage?.pinned?.includes("priority") ? "Set by you" : item.triage?.reason;
  return html`<span class="inbox-priority inbox-priority-${priority}" ${reason ? tip(reason) : nothing}
    >${priority[0]!.toUpperCase()}${priority.slice(1)}</span
  >`;
}

function itemRow(loop: LoopView, item: LoopItemView, member = false): TemplateResult {
  return html`
    <div class="loop-item ${member ? "loop-item-member" : ""}">
      <span class="loop-item-status loop-item-${item.status}">${item.status}</span>
      <span class="loop-item-key">${item.sourceKey}</span>
      <span class="loop-item-summary">${item.sourceSummary ?? ""}</span>
      <span class="loop-item-meta">
        ${item.attempts > 0 ? `${item.attempts} attempt${item.attempts === 1 ? "" : "s"}` : ""}
        ${item.parkedReason ? html` · <span title=${item.parkedReason}>parked</span>` : nothing}
      </span>
      ${priorityTpl(loop, item)}
    </div>
  `;
}

async function addIngestion(loop: LoopView): Promise<void> {
  await mutate(async () => {
    const result = await api<{ secret?: string }>(`/api/loops/${encodeURIComponent(loop.id)}/ingestion`, {
      method: "POST",
      body: JSON.stringify({
        kind: ingestionKind,
        ...(ingestionKind === "slack"
          ? {
              secret: ingestionSecret,
              teamId: ingestionTeam.trim(),
              channels: ingestionChannels.split(/[\s,]+/).filter(Boolean),
            }
          : {}),
      }),
    });
    createdSecret = result.secret ?? "";
    ingestionSecret = "";
    ingestionKind = "";
    await refreshDetail(loop.id);
  });
}

function ingestionTpl(loop: LoopView): TemplateResult {
  const names = { webhook: "Signed webhook", slack: "Slack events", gmail: "Gmail Pub/Sub" };
  return html`<section class="loop-ingestion">
    <div class="loop-ingestion-heading">
      <h2>Ingestion</h2>
      <span>${loop.cronId ? "Scheduled sync enabled" : "No scheduled sync"}</span>
    </div>
    <p>Choose how new work reaches this Loop. Event sources can run alongside a schedule.</p>
    ${ingestion?.sources.map(
      (source) =>
        html`<div class="loop-ingestion-source">
          <div class="loop-ingestion-source-head">
            <strong>${names[source.kind]}</strong><span>${source.enabled ? "Listening" : "Disabled"}</span
            ><button
              class="btn compact"
              ?disabled=${loopBusy}
              @click=${() =>
                mutate(async () => {
                  await api(`/api/loops/${encodeURIComponent(loop.id)}/ingestion/${encodeURIComponent(source.id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !source.enabled }),
                  });
                  await refreshDetail(loop.id);
                })}
            >
              ${source.enabled ? "Disable" : "Enable"}
            </button>
          </div>
          <label>Endpoint<input readonly .value=${source.url} aria-label=${`${names[source.kind]} endpoint`} /></label>
          ${source.gmail ? html`<p>${source.gmail.email} · watch renews automatically</p>` : nothing}
          ${source.channels?.length ? html`<p>Channels: ${source.channels.join(", ")}</p>` : nothing}
          <p>Last event: ${ago(source.lastReceivedAt)}${loop.state !== "enabled" ? " · Processing paused" : ""}</p>
          ${source.lastError ? html`<p class="error-banner">${source.lastError}</p>` : nothing}
        </div>`,
    )}
    ${
      createdSecret
        ? html`<div class="loop-ingestion-secret">
            <label
              >Signing secret — save it now; it is only shown once<input
                readonly
                .value=${createdSecret}
                aria-label="Webhook signing secret"
            /></label>
            <p>Sign the exact JSON body with HMAC-SHA256 and send its hex digest in X-Signature.</p>
            <button
              class="btn compact"
              @click=${() => {
                createdSecret = "";
                paint();
              }}
            >
              Done
            </button>
          </div>`
        : nothing
    }
    <div class="loop-ingestion-add">
      ${fieldSelect({
        ariaLabel: "Ingestion source",
        value: ingestionKind,
        onChange: (value) => {
          ingestionKind = value as typeof ingestionKind;
          ingestionSecret = "";
          paint();
        },
        options: html`<option value="">Add event source…</option>
          ${Object.entries(names)
            .filter(
              ([kind]) =>
                !ingestion?.sources.some((source) => source.kind === kind) &&
                (!loop.sources?.length ? true : kind !== "webhook" && loop.sources.includes(kind)),
            )
            .map(([kind, name]) => html`<option value=${kind}>${name}</option>`)}`,
      })}
    </div>
    ${
      ingestionKind === "slack"
        ? html`<div class="loop-ingestion-fields">
            <label
              >Workspace ID<input
                placeholder="T0123456789"
                .value=${ingestionTeam}
                @input=${(event: Event) => {
                  ingestionTeam = (event.target as HTMLInputElement).value;
                }} /></label
            ><label
              >Channel IDs<input
                placeholder="C0123456789, C9876543210"
                .value=${ingestionChannels}
                @input=${(event: Event) => {
                  ingestionChannels = (event.target as HTMLInputElement).value;
                }} /></label
            ><label
              >Slack signing secret<input
                type="password"
                autocomplete="off"
                .value=${ingestionSecret}
                @input=${(event: Event) => {
                  ingestionSecret = (event.target as HTMLInputElement).value;
                }}
            /></label>
            <p>
              Use the endpoint as your Slack app’s Events API request URL. Only human messages from these channels are
              accepted.
            </p>
          </div>`
        : nothing
    }
    ${ingestionKind === "gmail" ? html`<p>${ingestion?.gmailAvailable ? "Uses your connected personal Gmail account. New Inbox messages become Loop work items." : "An administrator must configure the Google Cloud Pub/Sub topic, audience, and push service account before Gmail can be enabled."}</p>` : nothing}
    ${ingestionKind ? html`<button class="btn compact" ?disabled=${loopBusy || (ingestionKind === "gmail" && !ingestion?.gmailAvailable)} @click=${() => void addIngestion(loop)}>${loopBusy ? "Connecting…" : `Enable ${names[ingestionKind]}`}</button>` : nothing}
  </section>`;
}

function detailTpl(detail: LoopDetail): TemplateResult {
  const { loop, items, outputs } = detail;
  const autopilot = loop.shipActions.length > 0 && loop.shipActions.every((policy) => policy.gate === "auto");
  const ready = outputs.filter((o) => o.state === "ready");
  const unconfirmed = outputs.filter((o) => o.state === "unconfirmed");
  const decided = outputs.filter((o) => o.state !== "ready" && o.state !== "unconfirmed");
  return html`
    ${listBackLink("Loops", () => {
      resetActiveLoop();
      paint();
      void refreshLoops();
    })}
    <div class="list-page-head">
      <div class="loop-title">
        <details
          class="loop-icon-picker"
          .open=${iconPickerOpen}
          @toggle=${(event: Event) => {
            iconPickerOpen = (event.currentTarget as HTMLDetailsElement).open;
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              iconPickerOpen = false;
              (event.currentTarget as HTMLDetailsElement).open = false;
              (event.currentTarget as HTMLElement).querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-label=${`Change icon for ${loop.name}`} title="Change icon">${loopIcon(loop, 24)}</summary>
          <div class="loop-icon-popover" role="group" aria-label="Loop icon">
            <span class="loop-icon-heading">Choose an icon</span>
            <div class="loop-icon-grid">
              ${LOOP_ICONS.map((choice) => html`<button type="button" aria-label=${choice.label} title=${choice.label} aria-pressed=${loop.icon === choice.id ? "true" : "false"} ?disabled=${loopBusy} @click=${() => void setLoopIcon(loop, choice.id)}>${loopIcon({ icon: choice.id }, 20)}</button>`)}
            </div>
            <label class="loop-icon-upload">
              <span>${loopBusy ? "Saving…" : "Upload image"}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                aria-label="Upload loop icon"
                ?disabled=${loopBusy}
                @change=${(event: Event) => {
                  const input = event.currentTarget as HTMLInputElement;
                  const file = input.files?.[0];
                  input.value = "";
                  if (file) void setLoopIcon(loop, file);
                }}
              />
            </label>
            <span class="loop-icon-hint">Images up to 2 MB, including SVG</span>
            <button
              class="loop-icon-default"
              type="button"
              ?disabled=${loopBusy || !loop.icon}
              @click=${() => void setLoopIcon(loop, null)}
            >
              ${loopIcon({ sources: loop.sources })}<span>Use default</span>
            </button>
          </div>
        </details>
        <h1 class="pane-title">${loop.name}</h1>
      </div>
      <div class="list-page-actions">
        ${healthBadge(loop)}
        <button class="btn" type="button" ?disabled=${loopBusy} @click=${() => fireNow(loop)}>
          ${icon(Zap, 14)}<span>Fire now</span>
        </button>
        ${
          loop.state === "enabled"
            ? html`<button class="btn" type="button" ?disabled=${loopBusy} @click=${() => setState(loop, "paused")}>
                ${icon(Pause, 14)}<span>Pause</span>
              </button>`
            : html`<button
                class="btn primary"
                type="button"
                ?disabled=${loopBusy}
                @click=${() => setState(loop, "enabled")}
              >
                ${icon(Play, 14)}<span>${loop.state === "quarantined" ? "Clear quarantine" : "Resume"}</span>
              </button>`
        }
      </div>
    </div>
    ${loop.healthReason ? html`<p class="loop-health-reason">${loop.healthReason}</p>` : nothing}
    ${loopsNotice ? html`<p class="error-banner">${loopsNotice}</p>` : nothing}
    ${
      loop.shipActions.length
        ? html`<button
            class="loop-autopilot ${autopilot ? "on" : ""}"
            type="button"
            role="switch"
            aria-checked=${autopilot ? "true" : "false"}
            ?disabled=${loopBusy}
            @click=${() => setAutopilot(loop, !autopilot)}
          >
            <span class="loop-autopilot-copy">
              <span class="loop-autopilot-label">Autopilot</span>
              <span class="loop-autopilot-sublabel"
                >${autopilot ? "Shipping without review" : "Ships outputs without review"}</span
              >
            </span>
            <span class="loop-autopilot-switch"><span></span></span>
          </button>`
        : nothing
    }

    <h2 class="loop-section-title">
      Ready to ship ${ready.length ? html`<span class="loop-count">${ready.length}</span>` : nothing}
    </h2>
    ${ready.length ? ready.map((o) => reviewRow(loop, o)) : html`<p class="list-empty">Nothing waiting on you.</p>`}

    <h2 class="loop-section-title">
      Needs confirmation ${unconfirmed.length ? html`<span class="loop-count">${unconfirmed.length}</span>` : nothing}
    </h2>
    ${
      unconfirmed.length
        ? unconfirmed.map((o) => reviewRow(loop, o, "Confirm shipped"))
        : html`<p class="list-empty">Nothing needs confirmation.</p>`
    }
    ${ingestionTpl(loop)}
    ${detail.triageAvailable || loop.triage?.prioritize?.enabled || loop.triage?.consolidate?.enabled ? triageTpl(loop, items) : nothing}
    <h2 class="loop-section-title">Playbook <span class="loop-count">v${loop.playbookVersion}</span></h2>
    <textarea
      class="loop-playbook"
      rows="10"
      .value=${playbookDraft ?? loop.playbook}
      @input=${(e: Event) => {
        playbookDraft = (e.target as HTMLTextAreaElement).value;
      }}
    ></textarea>
    <div class="loop-playbook-actions">
      <span class="loop-success-condition" title="success condition">Done when: ${loop.successCondition}</span>
      ${
        playbookDraft !== null && playbookDraft !== loop.playbook
          ? html`<button class="btn primary" type="button" ?disabled=${loopBusy} @click=${() => savePlaybook(loop)}>
              Save playbook
            </button>`
          : nothing
      }
    </div>

    <h2 class="loop-section-title">Work ledger</h2>
    ${items.length ? ledgerRows(loop, items) : html`<p class="list-empty">No items yet. Fire the loop.</p>`}
    ${
      decided.length
        ? html`<h2 class="loop-section-title">Decided</h2>
            ${decided.map(
              (o) => html`
                <div class="loop-output loop-output-decided">
                  <span class="loop-output-state loop-output-${o.state}">${o.state}</span>
                  <span class="loop-output-title">${o.title}</span>
                  <span class="loop-output-meta"
                    >${o.decidedBy ?? ""} ${o.decisionNote ? `· ${o.decisionNote}` : ""}</span
                  >
                </div>
              `,
            )}`
        : nothing
    }
  `;
}

function loopRow(loop: LoopView): TemplateResult {
  return html`
    <button class="list-row loop-row" type="button" @click=${() => openLoop(loop.id)}>
      ${loopIcon(loop, 18)}<span class="loop-row-name">${loop.name}</span>
      ${healthBadge(loop)}
      <span class="loop-row-meta">last fire ${ago(loop.lastFiredAt)}</span>
    </button>
  `;
}

function paint(): void {
  if (!loopsHost || appState.currentView !== "loops") return;
  if (activeLoopId) {
    render(activeDetail ? detailTpl(activeDetail) : html`<p class="list-empty">Loading…</p>`, loopsHost);
    return;
  }
  render(
    listPageTpl({
      title: "Loops",
      rows: loopList.map(loopRow),
      empty: loopsLoading
        ? "Loading…"
        : (loopsNotice ??
          "No loops yet. Ask the agent to set one up. The define-loop skill walks through it, shadow run first."),
    }),
    loopsHost,
  );
}

export async function renderLoopsPage(): Promise<void> {
  if (!can("loops")) return;
  if (!appState.mainEl) return;
  if (!loopsHost || loopsHost.parentElement !== appState.mainEl) {
    loopsHost = document.createElement("div");
    loopsHost.className = "pane loops-page";
    appState.mainEl.replaceChildren(loopsHost);
  }
  paint();
  await refreshLoops();
  if (activeLoopId) await refreshDetail(activeLoopId);
}
