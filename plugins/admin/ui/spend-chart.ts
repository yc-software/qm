import { html } from "lit";

const DAY = 86400000;
const PARTS = [
  ["live", "Live"],
  ["cron", "Crons"],
  ["background", "Background"],
] as const;
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function spendChart(data: any, breakdown: "category" | "model" = "category") {
  const models = [
    ...new Set<string | null>((data.series || []).flatMap((p: any) => (p.models || []).map((m: any) => m.model))),
  ].sort((a, b) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  });
  const parts =
    breakdown === "model"
      ? models.map((model) => {
          let hash = 0;
          for (const ch of model ?? "unknown") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
          return {
            key: model,
            label: model ?? "Unknown model",
            color: model === null ? "var(--muted)" : `hsl(${hash % 360} 55% 48%)`,
            cls: "spend-model",
          };
        })
      : PARTS.map(([key, label]) => ({ key, label, color: `var(--spend-${key})`, cls: `spend-${key}` }));
  const from = Date.parse(data.window.from),
    to = Date.parse(data.window.to);
  const weekly = data.window.bucket === "week";
  const step = (weekly ? 7 : 1) * DAY;
  const start = weekly ? from - ((new Date(from).getUTCDay() + 6) % 7) * DAY : from;
  const recorded = new Map((data.series || []).map((p: any) => [Date.parse(p.day), p]));
  const points: any[] = [];
  for (let t = start; t < to; t += step) {
    const p: any = recorded.get(t);
    const byModel = new Map((p?.models || []).map((m: any) => [m.model, m.costUsd]));
    points.push({
      t,
      values: parts.map(({ key }) =>
        Math.max(0, Number(breakdown === "model" ? byModel.get(key) : p?.[key!]?.costUsd) || 0),
      ),
    });
  }
  const peak = Math.max(0, ...points.map((p) => p.values.reduce((a: number, b: number) => a + b, 0)));
  const magnitude = 10 ** Math.floor(Math.log10(peak || 1));
  const ceiling = peak ? [1, 2, 2.5, 5, 10].find((n) => n * magnitude >= peak)! * magnitude : 1;
  const labelIndices = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  const total = Number(data.org?.costUsd) || 0;
  const detailParts = (i: number) => {
    const p = points[i];
    const first = Math.max(p.t, from),
      last = Math.min(p.t + step, to) - DAY;
    return [
      `${date(first)}${weekly && first !== last ? " – " + date(last) : ""}`,
      `${usd(p.values.reduce((a: number, b: number) => a + b, 0))} total`,
      ...parts.map(({ label }, k) => `${label} ${usd(p.values[k])}`),
    ];
  };
  const detail = (i: number) => detailParts(i).join(" · ");
  const inspect = (event: Event, i: number) => {
    const chart = (event.currentTarget as HTMLElement).closest(".spend-chart")!;
    chart.querySelector<HTMLElement>(".spend-chart-detail")!.replaceChildren(
      ...detailParts(i).map((text) => {
        const span = chart.ownerDocument.createElement("span");
        span.textContent = text;
        return span;
      }),
    );
    chart.querySelectorAll(".spend-column").forEach((el, k) => el.classList.toggle("inspected", i === k));
  };
  return html`<div class="spend-chart">
    <div class="spend-chart-summary">
      <div><strong>${usd(total)}</strong><span>Total spend</span></div>
      <div><strong>${usd(total / Math.max(1, (to - from) / DAY))}</strong><span>Average / day</span></div>
      <div class="spend-chart-legend">
        ${parts.map(({ label, color }) => html`<span><i style=${"background:" + color}></i>${label}</span>`)}
      </div>
    </div>
    <div
      class="spend-chart-plot"
      role="group"
      aria-label=${`Spend over time by ${breakdown} in US dollars. Focus a bar for its breakdown.`}
    >
      <div class="spend-chart-axis" aria-hidden="true">
        ${[4, 3, 2, 1, 0].map((n) => html`<span>${usd((ceiling * n) / 4)}</span>`)}
      </div>
      <div class="spend-chart-bars">
        <div class="spend-chart-grid" aria-hidden="true">${[0, 1, 2, 3, 4].map(() => html`<span></span>`)}</div>
        ${points.map(
          (p, i) =>
            html`<div
              class="spend-column"
              tabindex="0"
              role="img"
              aria-label=${detail(i)}
              @pointerenter=${(e: Event) => inspect(e, i)}
              @focus=${(e: Event) => inspect(e, i)}
              @click=${(e: Event) => inspect(e, i)}
            >
              ${parts.map(({ cls, color }, k) => html`<span class=${"spend-segment " + cls} style=${"height:" + (100 * p.values[k]) / ceiling + "%;background:" + color}></span>`)}
            </div>`,
        )}
      </div>
      <div class="spend-chart-dates" aria-hidden="true">
        ${points.map((p, i) => html`<span>${labelIndices.has(i) ? date(Math.max(p.t, from)) : ""}</span>`)}
      </div>
    </div>
    <div class="spend-chart-detail" aria-live="polite">
      Hover or focus a bar for the ${weekly ? "weekly" : "daily"} breakdown. USD · UTC.
    </div>
  </div>`;
}
