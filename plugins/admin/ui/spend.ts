import { html } from "lit";
import { table, card, renderer } from "./shared.ts";

type Services = Record<string, any>;

const RANGES = ["7d", "30d", "90d"];
const COLUMNS: Array<[string, string]> = [
  ["person", "Person"],
  ["costUsd", "Total"],
  ["live", "Live"],
  ["cron", "Crons"],
  ["background", "Background"],
  ["tokens", "Tokens"],
  ["cacheHitRatio", "Cache hit"],
];

const fmtUsd = (n: any) => "$" + (Number(n) || 0).toFixed(2);

function sortValue(row: any, key: string): number | string {
  if (key === "person") return String(row.displayName || row.principalId || row.scopeId || "").toLowerCase();
  if (key === "live" || key === "cron" || key === "background") return Number(row[key]?.costUsd || 0);
  if (key === "cacheHitRatio") return row.cacheHitRatio === null ? -1 : Number(row.cacheHitRatio);
  return Number(row[key] || 0);
}

export class SpendView {
  root: HTMLElement;
  data: any;
  services: Services;
  paint: (template: unknown) => void;
  filter = "";
  sortKey = "costUsd";
  sortDir: "asc" | "desc" = "desc";
  search: HTMLElement | null = null;
  constructor(root: HTMLElement, data: any, services: Services) {
    this.root = root;
    this.data = data;
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
        [fmtUsd(org.cron?.costUsd), "Crons"],
        [org.cacheHitRatio == null ? "n/a" : s.fmtPct(org.cacheHitRatio), "Cache hit rate"],
      ],
      tabs: RANGES.map((range) => ({
        label: range,
        active: (s.range || "30d") === range,
        onClick: () => s.setRange(range),
      })),
      search: {
        value: this.filter,
        placeholder: "person or scope",
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
  header() {
    return COLUMNS.map(
      ([key, label]) =>
        html`<button type="button" class="rowbtn" @click=${() => this.sortBy(key)}>${label}${this.arrow(key)}</button>`,
    );
  }
  rowCells(row: any) {
    const s = this.services;
    const name = row.displayName || (row.principalId ?? s.shortName(row.scopeId));
    return [
      { text: name, cls: "mono" },
      { text: fmtUsd(row.costUsd), cls: "num" },
      { text: fmtUsd(row.live?.costUsd), cls: "num" },
      { text: fmtUsd(row.cron?.costUsd), cls: "num" },
      { text: fmtUsd(row.background?.costUsd), cls: "num" },
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
    const series = this.data.series || [];
    const org = this.data.org || {};
    this.paint(
      html`${card(
        "Spend over time",
        series.length
          ? `${this.data.window?.from ?? ""} to ${this.data.window?.to ?? ""} (UTC, ${this.data.window?.bucket ?? "day"} buckets) · ${s.plural(org.calls || 0, "model call")}`
          : "No model calls recorded in this window.",
        series.length
          ? html`<div class="statline">
              ${s.sparkline(series, (r: any) => r.costUsd)} ${fmtUsd(org.costUsd)} across
              ${s.plural(series.length, "bucket")}
            </div>`
          : html`<p class="empty">Nothing to chart yet.</p>`,
      )}${card(
        "Spend per person",
        "Live is interactive conversation; Crons are scheduled runs; Background covers webhook and monitor runs.",
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
          this.header(),
          scopes.map((row: any) => this.rowCells(row)),
          this.data.scopes?.length ? "No scopes match." : "No shared-scope spend in this window.",
        ),
      )}`,
    );
  }
}

export function spend(root: HTMLElement, data: any, services: Services) {
  return new SpendView(root, data, services);
}
