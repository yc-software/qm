import { html, nothing, render, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { ensureContexts, scopeChip, scopeTitle } from "./contexts";
import { cronScheduleSummary, cronTitle } from "./cron-format";
import { openCronById, type CronView } from "./crons";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import { friendlyPrincipal } from "./deploy-view";
import { chipTabs } from "./list-page";
import { appState, switchView } from "./shell";
import { BACKGROUND_SOURCES, spendChart, usd } from "./spend-chart";
import { lastSpendDay, spendAsOf, spendCustomRange, spendWindow, spendWindowTabs } from "./spend-window";

interface SpendTotals {
  costUsd: number;
  calls: number;
  tokens: number;
  cacheHitRatio: number | null;
  live: { costUsd: number };
  background: { costUsd: number; sources: Record<string, { costUsd: number }> };
}

interface SpendScope extends SpendTotals {
  scopeId: string;
  displayName: string;
}

interface SpendCron extends SpendTotals {
  cronId: string;
  scopeId: string;
  scopeName: string;
  owned: boolean;
  info: (Pick<CronView, "title" | "message" | "action" | "owner" | "schedule"> & { id: string }) | null;
}

interface SpendReport {
  window: { from: string; to: string; bucket: "day" | "week" };
  org: SpendTotals;
  series: unknown[];
  people: SpendScope[];
  scopes: SpendScope[];
  crons: SpendCron[];
  models: (SpendTotals & { model: string | null })[];
  asOf?: number;
}

const MAX_DAYS = 93;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

let selection: { range?: string | null; from?: string | null; to?: string | null } = {};
let report: SpendReport | null = null;
let notice = "";
let loading = false;
let chart: "category" | "model" = "category";
let requestSeq = 0;
let host: HTMLDivElement | null = null;

export function resetSpendState(): void {
  selection = {};
  report = null;
  notice = "";
  loading = false;
  chart = "category";
  requestSeq++;
}

const currentWindow = () => spendWindow(selection, Date.now(), MAX_DAYS);

function choose(next: typeof selection): void {
  selection = next;
  const { from, to, bucket } = currentWindow();
  const shown = report?.window;
  if (!shown || shown.from !== from || shown.to !== to || shown.bucket !== bucket) return void renderSpend();
  requestSeq++;
  loading = false;
  notice = "";
  drawSpend();
}

function panel(
  title: string,
  copy: string,
  body: unknown,
  actions: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  return html`<section class="context-panel">
    <div class="context-panel-heading">
      <div>
        <h2 class="context-panel-title">${title}</h2>
        <p class="context-panel-copy">${copy}</p>
      </div>
      ${actions}
    </div>
    ${body}
  </section>`;
}

function split(t: SpendTotals): string {
  return [
    `Live ${usd(t.live.costUsd)}`,
    ...BACKGROUND_SOURCES.filter(([key]) => (t.background.sources[key]?.costUsd ?? 0) > 0).map(
      ([key, label]) => `${label} ${usd(t.background.sources[key]!.costUsd)}`,
    ),
  ].join(" · ");
}

function usage(t: SpendTotals): string {
  return [
    `${t.calls.toLocaleString("en-US")} ${t.calls === 1 ? "call" : "calls"}`,
    `${compact.format(t.tokens)} tokens`,
    ...(t.cacheHitRatio === null ? [] : [`${percent.format(t.cacheHitRatio)} cache hit`]),
  ].join(" · ");
}

function row(title: unknown, meta: unknown, costUsd: number): TemplateResult {
  return html`<div class="context-session-row context-resource-row spend-row">
    <span class="context-session-title" dir="auto">${title}</span>
    <span class="context-session-meta">${meta}<strong class="spend-amount">${usd(costUsd)}</strong></span>
  </div>`;
}

function rows(items: TemplateResult[], empty: string): TemplateResult {
  return items.length
    ? html`<div class="context-session-list">${items}</div>`
    : html`<div class="context-inline-empty">${empty}</div>`;
}

function cronRow(c: SpendCron, shared: ReadonlySet<string>): TemplateResult {
  const chip = shared.has(c.scopeId) ? scopeChip(c.scopeId, c.scopeName) : nothing;
  if (!c.info) return row(`Cron ${c.cronId.slice(0, 8)}`, chip, c.costUsd);
  const meta = html`${c.owned ? nothing : html`<span>${friendlyPrincipal(c.info.owner)}</span>`} ${chip}
    <span class="badge">${cronScheduleSummary(c.info)}</span>
    <a
      class="context-resource-link"
      href=${deepLinkPath(UI_BASE, "crons", null, null, c.cronId)}
      @click=${(event: MouseEvent) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        openCronById(c.cronId);
        switchView("crons");
      }}
      >Open</a
    >`;
  return row(cronTitle(c.info), meta, c.costUsd);
}

function body(r: SpendReport): TemplateResult {
  const yours = r.people[0];
  const shared = new Set(r.scopes.map((scope) => scope.scopeId));
  const sharedTotal = r.scopes.reduce((sum, scope) => sum + scope.costUsd, 0);
  const cronPanel = (title: string, copy: string, crons: SpendCron[], empty: string) =>
    panel(
      title,
      copy,
      rows(
        crons.map((c) => cronRow(c, shared)),
        empty,
      ),
    );
  return html`
    <div class="spend-stats">
      ${panel("Yours", yours ? split(yours) : "No personal spend in this window.", html`<strong>${usd(yours?.costUsd ?? 0)}</strong>`)}
      ${panel("Shared spaces", "Channels, group DMs and projects you can see", html`<strong>${usd(sharedTotal)}</strong>`)}
    </div>
    ${panel(
      "Spend over time",
      `${r.window.from} to ${lastSpendDay(r.window)} (UTC, ${r.window.bucket === "week" ? "weekly" : "daily"}), yours and your shared spaces together.`,
      r.series.length
        ? keyed(chart, spendChart(r, chart))
        : html`<div class="context-inline-empty">No model calls in this window.</div>`,
      r.series.length
        ? chipTabs(
            "Chart breakdown",
            (["category", "model"] as const).map((mode) => ({
              label: mode === "category" ? "Category" : "Model",
              active: chart === mode,
              onClick: () => {
                chart = mode;
                drawSpend();
              },
            })),
          )
        : nothing,
    )}
    ${panel(
      "By shared space",
      "Work in a channel, group DM or project is billed to that space, not to whoever asked.",
      rows(
        r.scopes.map((scope) =>
          row(scopeTitle(scope.scopeId, scope.displayName), html`<span>${split(scope)}</span>`, scope.costUsd),
        ),
        "No shared-space spend in this window.",
      ),
    )}
    ${cronPanel(
      "Your crons",
      "Each cron's runs and the subagents they start, in the space each one runs in.",
      r.crons.filter((c) => c.info && c.owned),
      "None of your crons ran in this window.",
    )}
    ${cronPanel(
      "Crons others made",
      "Crons someone else made that run in a shared space you can see.",
      r.crons.filter((c) => c.info && !c.owned),
      "No crons from others ran in this window.",
    )}
    ${
      r.crons.some((c) => !c.info)
        ? cronPanel(
            "Deleted or private crons",
            "Crons that no longer exist or that you can't open, in the space they ran in.",
            r.crons.filter((c) => !c.info),
            "",
          )
        : nothing
    }
    ${panel(
      "By model",
      "Yours and your shared spaces, split by the model recorded on each call.",
      rows(
        r.models.map((m) => row(m.model ?? "Unknown model", html`<span>${usage(m)}</span>`, m.costUsd)),
        "No model calls in this window.",
      ),
    )}
    <p class="spend-footnote">
      Amounts are QM's estimates at each model's list price, so your organization's bill can differ.
      ${appState.me?.modelAuthConnected ? "Calls on your connected AI account are priced the same way." : nothing}
    </p>
  `;
}

function statusLine(): TemplateResult | typeof nothing {
  if (notice || loading) return html`<div class="status">${notice || "Loading…"}</div>`;
  if (report?.asOf == null) return nothing;
  return html`<div class="status">${spendAsOf(report.asOf)}</div>`;
}

function drawSpend(): void {
  if (appState.currentView !== "spend" || !appState.mainEl) return;
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "pane spend-page";
    appState.mainEl.replaceChildren(host);
  }
  const current = currentWindow();
  render(
    html`
      <div class="list-page-head">
        <div>
          <h1 class="pane-title">Spend</h1>
          <div class="pane-subtitle">What QM's model calls cost for you and the spaces you can see.</div>
        </div>
        <div class="list-page-actions">
          ${chipTabs(
            "Spend window",
            spendWindowTabs(
              current,
              (range) => choose({ range }),
              (from, to) => choose({ from, to }),
            ),
          )}
        </div>
      </div>
      <div class="spend-content">
        ${spendCustomRange(current, (from, to) => choose({ from, to }), MAX_DAYS)} ${statusLine()}
        ${report ? body(report) : nothing}
      </div>
    `,
    host,
  );
}

export async function renderSpend(): Promise<void> {
  if (appState.currentView !== "spend") return;
  const seq = ++requestSeq;
  const { from, to, bucket } = currentWindow();
  loading = true;
  notice = "";
  drawSpend();
  try {
    const [next] = await Promise.all([
      api<SpendReport>(`/api/spend?${new URLSearchParams({ from, to, bucket })}`),
      ensureContexts(),
    ]);
    if (seq !== requestSeq) return;
    report = next;
  } catch (e) {
    if (seq !== requestSeq) return;
    report = null;
    notice = errMessage(e, "Failed to load spend.");
  }
  loading = false;
  drawSpend();
}
