import { html, render } from "lit";
import type { AdminPage } from "./sections.ts";
import { spendChart } from "./spend-chart.ts";
import { pageHeader, table, card } from "./shared.ts";

const DAY = 86400000;
const PRESETS = new Map(Object.entries({ "7d": 7, "30d": 30, "90d": 90 }));
const MAX_CUSTOM_DAYS = 366;

const usd = (n: any) => "$" + (Number(n) || 0).toFixed(2);
const pct = (n: any) => (n == null ? "n/a" : (Number(n) * 100).toFixed(1) + "%");
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function dayMs(day: unknown): number | null {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && isoDay(ms) === day ? ms : null;
}

type SpendWindow = { from: string; to: string; preset: string | null; bucket: "day" | "week" };

function windowOf(start: number, end: number, preset: string | null): SpendWindow {
  return { from: isoDay(start), to: isoDay(end), preset, bucket: end - start > 62 * DAY ? "week" : "day" };
}

export function spendWindow(
  state: { range?: string | null; from?: string | null; to?: string | null },
  now = Date.now(),
): SpendWindow {
  const tomorrow = Math.floor(now / DAY) * DAY + DAY;
  const from = dayMs(state.from);
  const to = dayMs(state.to);
  const end = to === null ? null : Math.min(to, tomorrow);
  if (from !== null && end !== null && from < end)
    return windowOf(Math.max(from, end - MAX_CUSTOM_DAYS * DAY), end, null);
  const preset = state.range && PRESETS.has(state.range) ? state.range : "30d";
  return windowOf(tomorrow - PRESETS.get(preset)! * DAY, tomorrow, preset);
}

const COLUMNS = ["Total", "Live", "Background", "Tokens", "Cache hit"];
const amounts = (row: any) => [
  { text: usd(row.costUsd), cls: "num" },
  { text: usd(row.live?.costUsd), cls: "num" },
  { text: usd(row.background?.costUsd), cls: "num" },
  { text: Number(row.tokens || 0).toLocaleString(), cls: "num" },
  { text: pct(row.cacheHitRatio), cls: "num" },
];

export async function mount(page: AdminPage) {
  const w = spendWindow({ range: page.params.get("range"), from: page.params.get("from"), to: page.params.get("to") });
  const query = new URLSearchParams({ from: w.from, to: w.to, bucket: w.bucket }).toString();
  const r = await page.api("GET", "/api/spend?" + query);
  if (!page.current()) return;
  const header = pageHeader({
    tabs: [
      ...[...PRESETS.keys()].map((range) => ({
        label: range,
        active: w.preset === range,
        href: page.href("spend", { range }),
      })),
      { label: "Custom", active: w.preset === null, href: page.href("spend", { from: w.from, to: w.to }) },
    ],
    actions: html`<a class="btn" href=${page.apiBase + "/spend?format=csv&breakdown=entity&" + query} download
      >Export CSV</a
    >`,
  });
  if (!r.ok)
    return render(
      html`${header}
        <p class="empty">
          ${r.status === 403 ? "You don't administer this scope." : r.data?.message || `Failed to load (${r.status}).`}
        </p>`,
      page.host,
    );
  const d = r.data || {};
  const org = d.org || {};
  const apply = (event: Event) => {
    event.preventDefault();
    const [first, last] = [...(event.currentTarget as HTMLFormElement).querySelectorAll("input")]
      .map((i) => i.value)
      .sort();
    const end = dayMs(last);
    if (dayMs(first) !== null && end !== null) page.go(page.href("spend", { from: first, to: isoDay(end + DAY) }));
  };
  const today = isoDay(Date.now());
  render(
    html`${header}${
      w.preset === null
        ? html`<form class="spend-custom" @submit=${apply}>
            <input type="date" aria-label="First day" required max=${today} .value=${w.from} />
            <span>to</span>
            <input type="date" aria-label="Last day" required max=${today} .value=${isoDay(Date.parse(w.to) - DAY)} />
            <button class="btn primary">Apply</button>
            <span class="hint">UTC, up to ${MAX_CUSTOM_DAYS} days</span>
          </form>`
        : null
    }${
      d.asOf == null
        ? null
        : html`<p class="subline">Totals as of ${new Date(d.asOf).toLocaleString()}. Updated every minute.</p>`
    }${card(
      "Spend over time",
      d.series?.length
        ? `${w.from} to ${w.to} (UTC, ${w.bucket} buckets) · ${org.calls || 0} model calls`
        : "No model calls recorded in this window.",
      d.series?.length ? spendChart(d) : html`<p class="empty">Nothing to chart yet.</p>`,
    )}${card(
      "Spend per person",
      "Live is interactive conversation. Background is work nobody is typing into: crons, loops, swarms, webhooks and monitors.",
      table(
        ["Person", ...COLUMNS],
        (d.people || []).map((row: any) => [
          {
            node: html`<a href=${page.href("user", { principal: row.principalId })}
              >${row.displayName || row.principalId}</a
            >`,
            cls: "mono",
          },
          ...amounts(row),
        ]),
        "No spend recorded in this window.",
      ),
    )}${card(
      "Shared scopes",
      "Channels, groups and teams are billed to the scope, not to a speaker. These rows plus the people above make up the org total.",
      table(
        ["Scope", ...COLUMNS],
        (d.scopes || []).map((row: any) => [{ text: row.displayName || row.scopeId, cls: "mono" }, ...amounts(row)]),
        "No shared-scope spend in this window.",
      ),
    )}${card(
      "Spend per cron",
      "Each cron's scheduled runs, including the subagents they start. A deleted cron keeps its spend under its id.",
      table(
        ["Cron", "Total", "Tokens", "Cache hit"],
        (d.crons || []).map((row: any) => [
          {
            node: html`<a
                href=${page.href("history", { scope: row.info?.ownerScopeId ?? row.scopeId, kind: "cron", cron: row.cronId })}
                >${row.info?.title || row.info?.message || row.cronId}</a
              >
              <div class="subline">${row.scopeName || row.scopeId}${row.info ? "" : " · deleted"}</div>`,
            cls: "mono",
          },
          { text: usd(row.costUsd), cls: "num" },
          { text: Number(row.tokens || 0).toLocaleString(), cls: "num" },
          { text: pct(row.cacheHitRatio), cls: "num" },
        ]),
        "No cron spend in this window.",
      ),
    )}${card(
      "Spend by model",
      "Same org spend, split by the model recorded on each call. Unknown model covers calls without a model ID.",
      table(
        ["Model", ...COLUMNS],
        (d.models || []).map((row: any) => [{ text: row.model || "Unknown model", cls: "mono" }, ...amounts(row)]),
        "No model breakdown available in this window.",
      ),
    )}`,
    page.host,
  );
}
