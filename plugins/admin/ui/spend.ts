import { html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { spendChart } from "./spend-chart.ts";
import { table, card, renderer } from "./shared.ts";

type Services = Record<string, any>;

const DAY = 86400000;
const PRESETS = new Map([
  ["7d", 7],
  ["30d", 30],
  ["90d", 90],
]);
const MAX_CUSTOM_DAYS = 366;
const COLUMNS: Array<[string, string]> = [
  ["person", "Person"],
  ["costUsd", "Total"],
  ["live", "Live"],
  ["background", "Background"],
  ["tokens", "Tokens"],
  ["cacheHitRatio", "Cache hit"],
];
const SCOPE_COLUMNS: Array<[string, string]> = [["person", "Scope"], ...COLUMNS.slice(1)];
const MODEL_COLUMNS: Array<[string, string]> = [["person", "Model"], ...COLUMNS.slice(1)];
const BACKGROUND_SOURCES: Array<[string, string]> = [
  ["cron", "Crons"],
  ["loop", "Loops"],
  ["swarm", "Swarms"],
  ["webhook", "Webhooks"],
  ["monitor", "Monitors"],
];
const SOURCE_COLUMNS: Array<[string, string]> = [
  ["person", "Source"],
  ["costUsd", "Total"],
  ["share", "Share of background"],
  ["calls", "Calls"],
  ["tokens", "Tokens"],
];
const CRON_COLUMNS: Array<[string, string]> = [
  ["person", "Cron"],
  ["costUsd", "Total"],
  ["tokens", "Tokens"],
  ["cacheHitRatio", "Cache hit"],
];

const rowName = (row: any) =>
  "source" in row
    ? row.label
    : "model" in row
      ? row.model || "Unknown model"
      : row.displayName || row.principalId || row.scopeId || "";

const fmtUsd = (n: any) => "$" + (Number(n) || 0).toFixed(2);

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function dayMs(day: unknown): number | null {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && isoDay(ms) === day ? ms : null;
}

interface SpendWindow {
  from: string;
  to: string;
  preset: string | null;
  bucket: "day" | "week";
}

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

function sortValue(row: any, key: string): number | string {
  if (key === "person") return String(rowName(row)).toLowerCase();
  if (key === "live" || key === "background") return Number(row[key]?.costUsd || 0);
  if (key === "cacheHitRatio") return row.cacheHitRatio === null ? -1 : Number(row.cacheHitRatio);
  return Number(row[key] || 0);
}

export class SpendView {
  root: HTMLElement;
  data: any;
  services: Services;
  paint: (template: unknown) => void;
  filter = "";
  chartBreakdown: "category" | "model" | "person";
  sortKey = "costUsd";
  sortDir: "asc" | "desc" = "desc";
  search: HTMLElement | null = null;
  constructor(root: HTMLElement, data: any, services: Services) {
    this.root = root;
    this.data = data;
    this.chartBreakdown =
      data.series?.length && data.series.every((p: any) => Array.isArray(p.models)) ? "model" : "category";
    this.services = services;
    this.paint = renderer(root);
    this.renderShell();
    this.draw();
  }
  renderShell() {
    const s = this.services;
    const org = this.data.org || {};
    const document = this.root.ownerDocument;
    const previous = this.search;
    if (previous && !previous.isConnected) return;
    const active = document.activeElement as HTMLElement | null;
    const focused = !!active && !!previous?.contains(active);
    const exportCsv = document.createElement("button");
    exportCsv.type = "button";
    exportCsv.textContent = "Export CSV";
    exportCsv.onclick = () => s.downloadCsv();
    s.defaultShell({
      stats: [
        [fmtUsd(org.costUsd), "Total spend"],
        [fmtUsd(org.live?.costUsd), "Live"],
        [fmtUsd(org.background?.costUsd), "Background"],
        [org.cacheHitRatio == null ? "n/a" : s.fmtPct(org.cacheHitRatio), "Cache hit rate"],
      ],
      tabs: [
        ...[...PRESETS.keys()].map((range) => ({
          label: range,
          active: s.window.preset === range,
          onClick: () => s.setRange(range),
        })),
        {
          label: "Custom",
          active: s.window.preset === null,
          onClick: () => s.setCustomRange(s.window.from, s.window.to),
        },
      ],
      search: {
        value: this.filter,
        placeholder: "person, scope, cron or model",
        onInput: (value: string) => {
          this.filter = value;
          this.draw();
        },
      },
      actions: [exportCsv],
    });
    const search = document.querySelector<HTMLElement>("#shellbar .shell-search");
    if (previous && search) {
      search.replaceWith(previous);
      if (focused) active?.focus({ preventScroll: true });
    } else this.search = search;
  }
  customRange() {
    const current: SpendWindow = this.services.window;
    if (current.preset !== null) return null;
    const today = isoDay(Date.now());
    const apply = (event: Event) => {
      event.preventDefault();
      const [first, last] = [...this.root.querySelectorAll<HTMLInputElement>(".spend-custom input")]
        .map((input) => input.value)
        .sort();
      const end = dayMs(last);
      if (dayMs(first) !== null && end !== null) this.services.setCustomRange(first, isoDay(end + DAY));
    };
    return html`<form class="spend-custom" @submit=${apply}>
      <input type="date" aria-label="First day" required max=${today} .value=${current.from} />
      <span>to</span>
      <input type="date" aria-label="Last day" required max=${today} .value=${isoDay(Date.parse(current.to) - DAY)} />
      <button class="primary">Apply</button>
      <span class="hint">UTC, up to ${MAX_CUSTOM_DAYS} days</span>
    </form>`;
  }
  sortBy(key: string) {
    if (this.sortKey === key) this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    else {
      this.sortKey = key;
      this.sortDir = "asc";
    }
    this.draw();
  }
  arrow(key: string) {
    if (this.sortKey !== key) return "";
    return this.sortDir === "asc" ? " ↑" : " ↓";
  }
  header(columns = COLUMNS) {
    return columns.map(
      ([key, label]) =>
        html`<button type="button" class="rowbtn" @click=${() => this.sortBy(key)}>${label}${this.arrow(key)}</button>`,
    );
  }
  rowCells(row: any) {
    const s = this.services;
    const name = "model" in row ? rowName(row) : row.displayName || (row.principalId ?? s.shortName(row.scopeId));
    return [
      { text: name, cls: "mono" },
      { text: fmtUsd(row.costUsd), cls: "num" },
      { text: fmtUsd(row.live?.costUsd), cls: "num" },
      { node: this.backgroundCell(row.background), cls: "num" },
      { text: s.fmtTokens(row.tokens || 0), cls: "num" },
      { text: row.cacheHitRatio == null ? "n/a" : s.fmtPct(row.cacheHitRatio), cls: "num" },
    ];
  }
  backgroundCell(background: any) {
    const parts = BACKGROUND_SOURCES.filter(([key]) => Number(background?.sources?.[key]?.costUsd) > 0).map(
      ([key, label]) => `${label} ${fmtUsd(background.sources[key].costUsd)}`,
    );
    return html`${fmtUsd(background?.costUsd)}${parts.length ? html`<div class="subline">${parts.join(" · ")}</div>` : null}`;
  }
  sourceCells(row: any) {
    const s = this.services;
    return [
      { text: row.label },
      { text: fmtUsd(row.costUsd), cls: "num" },
      { text: row.share == null ? "n/a" : s.fmtPct(row.share), cls: "num" },
      { text: Number(row.calls || 0).toLocaleString(), cls: "num" },
      { text: s.fmtTokens(row.tokens || 0), cls: "num" },
    ];
  }
  cronCells(row: any) {
    const s = this.services;
    const where = [
      row.scopeName || s.shortName(row.scopeId),
      row.info ? s.shortSchedule(row.info.schedule) : "deleted",
    ];
    return [
      {
        node: html`${row.displayName}
          <div class="subline">${where.join(" · ")}</div>`,
        cls: "mono",
      },
      { text: fmtUsd(row.costUsd), cls: "num" },
      { text: s.fmtTokens(row.tokens || 0), cls: "num" },
      { text: row.cacheHitRatio == null ? "n/a" : s.fmtPct(row.cacheHitRatio), cls: "num" },
    ];
  }
  draw() {
    const s = this.services;
    const needle = this.filter.trim().toLowerCase();
    const matches = (row: any) =>
      [row.principalId || "", row.scopeId || "", row.displayName || ""].join(" ").toLowerCase().includes(needle);
    const sorted = (rows: any[]) =>
      rows.slice().sort((a, b) => {
        const left = sortValue(a, this.sortKey);
        const right = sortValue(b, this.sortKey);
        if (left === right) return 0;
        const order = left < right ? -1 : 1;
        return this.sortDir === "asc" ? order : -order;
      });
    const people = sorted((this.data.people || []).filter(matches));
    const scopes = sorted((this.data.scopes || []).filter(matches));
    const crons = sorted(
      (this.data.crons || [])
        .map((row: any) => ({ ...row, displayName: s.cronName({ ...row.info, id: row.cronId }, true) }))
        .filter((row: any) =>
          [row.cronId, row.scopeId, row.scopeName, row.info?.ownerScopeId, row.displayName]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        ),
    );
    const backgroundTotal = Number(this.data.org?.background?.costUsd) || 0;
    const sources = sorted(
      BACKGROUND_SOURCES.map(([source, label]) => {
        const totals = this.data.org?.background?.sources?.[source] || {};
        return {
          source,
          label,
          costUsd: Number(totals.costUsd) || 0,
          calls: Number(totals.calls) || 0,
          tokens: Number(totals.tokens) || 0,
          share: backgroundTotal > 0 ? (Number(totals.costUsd) || 0) / backgroundTotal : null,
        };
      }).filter((row) => row.label.toLowerCase().includes(needle)),
    );
    const models = sorted((this.data.models || []).filter((row: any) => rowName(row).toLowerCase().includes(needle)));
    const series = this.data.series || [];
    const org = this.data.org || {};
    this.paint(
      html`${this.customRange()}${
        this.data.asOf == null
          ? null
          : html`<p class="subline">
              Totals as of ${new Date(this.data.asOf).toLocaleString()}. Updated every minute.
            </p>`
      }${card(
        "Spend over time",
        series.length
          ? `${this.data.window?.from ?? ""} to ${this.data.window?.to ?? ""} (UTC, ${this.data.window?.bucket ?? "day"} buckets) · ${s.plural(org.calls || 0, "model call")}`
          : "No model calls recorded in this window.",
        series.length
          ? keyed(this.chartBreakdown, spendChart(this.data, this.chartBreakdown))
          : html`<p class="empty">Nothing to chart yet.</p>`,
        series.length
          ? html`<div class="spend-chart-switch" role="group" aria-label="Chart breakdown">
              ${(["category", "model", "person"] as const).map(
                (mode) =>
                  html`<button
                    type="button"
                    aria-pressed=${this.chartBreakdown === mode}
                    ?disabled=${mode !== "category" && !series.every((p: any) => Array.isArray(p[mode === "person" ? "people" : "models"]))}
                    @click=${() => {
                      this.chartBreakdown = mode;
                      this.draw();
                    }}
                  >
                    ${{ category: "Category", model: "Model", person: "Person" }[mode]}
                  </button>`,
              )}
            </div>`
          : null,
      )}${card(
        "Spend per person",
        "Live is interactive conversation. Background is work nobody is typing into: crons, loops, swarms, webhooks and monitors, split out under each amount.",
        table(
          this.header(),
          people.map((row: any) => this.rowCells(row)),
          this.data.people?.length ? "No people match." : "No spend recorded in this window.",
          (i) => {
            const principalId = people[i]?.principalId;
            if (principalId) s.openUser(principalId);
          },
        ),
      )}${card(
        "Shared scopes",
        "Channels, groups and teams are billed to the scope, not to a speaker. These rows plus the people above make up the org total.",
        table(
          this.header(SCOPE_COLUMNS),
          scopes.map((row: any) => this.rowCells(row)),
          this.data.scopes?.length ? "No scopes match." : "No shared-scope spend in this window.",
        ),
      )}${card(
        "Background by source",
        "Where background spend comes from. Subagents count toward the run that started them.",
        table(
          this.header(SOURCE_COLUMNS),
          sources.map((row: any) => this.sourceCells(row)),
          "No sources match.",
        ),
      )}${card(
        "Spend per cron",
        "Each cron's scheduled runs, including the subagents they start. A deleted cron keeps its spend under its id.",
        html`<div class="spend-crons">
          ${table(
            this.header(CRON_COLUMNS),
            crons.map((row: any) => this.cronCells(row)),
            this.data.crons?.length ? "No crons match." : "No cron spend in this window.",
            (i) => {
              const row = crons[i];
              if (row) s.openCronRuns(row.cronId, row.info?.ownerScopeId ?? row.scopeId);
            },
          )}
        </div>`,
        html`<button type="button" @click=${() => s.downloadCsv("cron")}>Export cron CSV</button>`,
      )}${card(
        "Spend by model",
        "Same org spend, split by the model recorded on each call. Unknown model covers calls without a model ID.",
        html`<div class="spend-models">
          ${table(
            this.header(MODEL_COLUMNS),
            models.map((row: any) => this.rowCells(row)),
            this.data.models?.length ? "No models match." : "No model breakdown available in this window.",
          )}
        </div>`,
        html`<button type="button" @click=${() => s.downloadCsv("model")}>Export model CSV</button>`,
      )}`,
    );
  }
}

export function spend(root: HTMLElement, data: any, services: Services) {
  return new SpendView(root, data, services);
}
