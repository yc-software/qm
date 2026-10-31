import { html } from "lit";

const DAY = 86400000;
const PARTS = [
  ["live", "Live"],
  ["cron", "Crons"],
  ["loop", "Loops"],
  ["swarm", "Swarms"],
  ["webhook", "Webhooks"],
  ["monitor", "Monitors"],
] as const;
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function spendChart(data: any) {
  const from = Date.parse(data.window.from);
  const to = Date.parse(data.window.to);
  const weekly = data.window.bucket === "week";
  const step = (weekly ? 7 : 1) * DAY;
  const start = weekly ? from - ((new Date(from).getUTCDay() + 6) % 7) * DAY : from;
  const recorded = new Map((data.series || []).map((p: any) => [Date.parse(p.day), p]));
  const points: { t: number; values: number[] }[] = [];
  for (let t = start; t < to; t += step) {
    const p: any = recorded.get(t);
    const cost = (key: string) => (key === "live" ? p?.live : p?.background?.sources?.[key])?.costUsd;
    points.push({ t, values: PARTS.map(([key]) => Math.max(0, Number(cost(key)) || 0)) });
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const peak = Math.max(0, ...points.map((p) => sum(p.values)));
  const magnitude = 10 ** Math.floor(Math.log10(peak || 1));
  const ceiling = peak ? [1, 2, 2.5, 5, 10].find((n) => n * magnitude >= peak)! * magnitude : 1;
  const labelIndices = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  const total = Number(data.org?.costUsd) || 0;
  const detail = (p: (typeof points)[number]) => {
    const first = Math.max(p.t, from);
    const last = Math.min(p.t + step, to) - DAY;
    return [
      `${date(first)}${weekly && first !== last ? " – " + date(last) : ""}`,
      `${usd(sum(p.values))} total`,
      ...PARTS.map(([, label], k) => `${label} ${usd(p.values[k]!)}`),
    ].join(" · ");
  };
  return html`<div class="spend-chart">
    <div class="spend-chart-summary">
      <div><strong>${usd(total)}</strong><span>Total spend</span></div>
      <div><strong>${usd(total / Math.max(1, (to - from) / DAY))}</strong><span>Average / day</span></div>
      <div class="spend-chart-legend">
        ${PARTS.map(([key, label]) => html`<span><i class=${"spend-" + key}></i>${label}</span>`)}
      </div>
    </div>
    <div class="spend-chart-plot" role="group" aria-label="Spend over time by category in US dollars.">
      <div class="spend-chart-axis" aria-hidden="true">
        ${[4, 3, 2, 1, 0].map((n) => html`<span>${usd((ceiling * n) / 4)}</span>`)}
      </div>
      <div class="spend-chart-bars">
        <div class="spend-chart-grid" aria-hidden="true">${[0, 1, 2, 3, 4].map(() => html`<span></span>`)}</div>
        ${points.map(
          (p) =>
            html`<div class="spend-column" tabindex="0" role="img" aria-label=${detail(p)} title=${detail(p)}>
              ${PARTS.map(
                ([key], k) =>
                  html`<span
                    class=${"spend-segment spend-" + key}
                    style=${"height:" + (100 * p.values[k]!) / ceiling + "%"}
                  ></span>`,
              )}
            </div>`,
        )}
      </div>
      <div class="spend-chart-dates" aria-hidden="true">
        ${points.map((p, i) => html`<span>${labelIndices.has(i) ? date(Math.max(p.t, from)) : ""}</span>`)}
      </div>
    </div>
  </div>`;
}
