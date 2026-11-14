import { html, render } from "lit";
import { errMessage } from "../../chassis/src/errors";
import type { AdminPage } from "./admin/sections";
import { card, pageHeader, table } from "./admin/shared";
import { spendAsOf, spendCustomRange, spendWindow, spendWindowTabs } from "./admin/spend";
import { spendChart } from "./admin/spend-chart";
import { api } from "./core-bridge";
import { cronScheduleSummary } from "./cron-format";
import type { CronView } from "./crons";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import { friendlyPrincipal } from "./app-view";
import { appState } from "./shell-state";

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
  info: Pick<CronView, "id" | "title" | "message" | "action" | "owner" | "schedule"> | null;
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
const DAY = 86_400_000;
const SOURCES = [
  ["cron", "Crons"],
  ["loop", "Loops"],
  ["swarm", "Swarms"],
  ["webhook", "Webhooks"],
  ["monitor", "Monitors"],
] as const;
const usd = (n: unknown) => "$" + (Number(n) || 0).toFixed(2);
const pct = (n: number | null) => (n == null ? "n/a" : (n * 100).toFixed(1) + "%");
const num = (text: string) => ({ text, cls: "num" });

function split(t: SpendTotals): string {
  return [
    `Live ${usd(t.live.costUsd)}`,
    ...SOURCES.filter(([key]) => (Number(t.background.sources[key]?.costUsd) || 0) > 0).map(
      ([key, label]) => `${label} ${usd(t.background.sources[key]!.costUsd)}`,
    ),
  ].join(" · ");
}

function cronLink(c: NamedCron) {
  const href = deepLinkPath(UI_BASE, "crons", null, null, c.cronId);
  return {
    node: html`<a
      href=${href}
      @click=${(event: MouseEvent) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        history.pushState(null, "", href);
        dispatchEvent(new PopStateEvent("popstate"));
      }}
      >${c.info.title?.trim() || c.info.message || c.info.action || c.cronId}</a
    >`,
  };
}

type NamedCron = SpendCron & { info: NonNullable<SpendCron["info"]> };
const named = (c: SpendCron): c is NamedCron => c.info !== null;
function spaceName(scopeId: string, name: string): string {
  if (scopeId.startsWith("personal:")) return "Personal";
  if (!name) return scopeId.startsWith("group:") ? "Group DM" : scopeId;
  return scopeId.startsWith("channel:") ? `#${name}` : name;
}
const space = (c: SpendCron) => spaceName(c.scopeId, c.scopeName);

function body(r: SpendReport) {
  const yours = r.people[0];
  const shared = r.scopes.reduce((sum, scope) => sum + (Number(scope.costUsd) || 0), 0);
  const mine = r.crons.filter(named).filter((c) => c.owned);
  const theirs = r.crons.filter(named).filter((c) => !c.owned);
  const hidden = r.crons.filter((c) => !named(c));
  const last = new Date(Date.parse(r.window.to) - DAY).toISOString().slice(0, 10);
  return html`${card(
      "Spend over time",
      `${r.window.from} to ${last} (UTC, ${r.window.bucket === "week" ? "weekly" : "daily"}) · Yours ${usd(yours?.costUsd)} · Shared spaces ${usd(shared)}`,
      r.series.length ? spendChart(r) : html`<p class="empty">No model calls in this window.</p>`,
    )}${card(
      "By shared space",
      "Work in a channel, group DM or project is billed to that space, not to whoever asked.",
      table(
        ["Space", "Split", "Total"],
        r.scopes.map((s) => [spaceName(s.scopeId, s.displayName), split(s), num(usd(s.costUsd))]),
        "No shared-space spend in this window.",
      ),
    )}${card(
      "Your crons",
      "Each cron's runs and the subagents they start, in the space each one runs in.",
      table(
        ["Cron", "Space", "Schedule", "Total"],
        mine.map((c) => [cronLink(c), space(c), cronScheduleSummary(c.info), num(usd(c.costUsd))]),
        "None of your crons ran in this window.",
      ),
    )}${card(
      "Crons others made",
      "Crons someone else made that run in a shared space you can see.",
      table(
        ["Cron", "Owner", "Space", "Schedule", "Total"],
        theirs.map((c) => [
          cronLink(c),
          friendlyPrincipal(c.info.owner),
          space(c),
          cronScheduleSummary(c.info),
          num(usd(c.costUsd)),
        ]),
        "No crons from others ran in this window.",
      ),
    )}${
      hidden.length
        ? card(
            "Deleted or private crons",
            "Crons that no longer exist or that you can't open, in the space they ran in.",
            table(
              ["Cron", "Space", "Total"],
              hidden.map((c) => [{ text: `Cron ${c.cronId.slice(0, 8)}`, cls: "mono" }, space(c), num(usd(c.costUsd))]),
              "",
            ),
          )
        : null
    }${card(
      "By model",
      "Yours and your shared spaces, split by the model recorded on each call.",
      table(
        ["Model", "Calls", "Tokens", "Cache hit", "Total"],
        r.models.map((m) => [
          { text: m.model ?? "Unknown model", cls: "mono" },
          num(m.calls.toLocaleString("en-US")),
          num(m.tokens.toLocaleString("en-US")),
          num(pct(m.cacheHitRatio)),
          num(usd(m.costUsd)),
        ]),
        "No model calls in this window.",
      ),
    )}
    <p class="subline">
      Amounts are QM's estimates at each model's list price, so your organization's bill can differ.
      ${appState.me?.modelAuthConnected ? "Calls on your connected AI account are priced the same way." : null}
    </p>`;
}

export async function mount(page: AdminPage): Promise<void> {
  const params = page.params;
  const w = spendWindow(
    { range: params.get("range"), from: params.get("from"), to: params.get("to") },
    Date.now(),
    MAX_DAYS,
  );
  const header = pageHeader({
    context: "What QM's model calls cost for you and the spaces you can see.",
    tabs: spendWindowTabs(page, w),
  });
  render(
    html`${header}
      <p class="subline">Loading…</p>`,
    page.host,
  );
  let report: SpendReport | null = null;
  let error = "";
  try {
    report = await api<SpendReport>(`/api/spend?${new URLSearchParams({ from: w.from, to: w.to, bucket: w.bucket })}`);
  } catch (e) {
    error = errMessage(e, "Failed to load spend.");
  }
  if (!page.current()) return;
  render(
    html`${header}${spendCustomRange(page, w, MAX_DAYS)}${
      report ? html`${spendAsOf(report.asOf)}${body(report)}` : html`<p class="empty">${error}</p>`
    }`,
    page.host,
  );
}
