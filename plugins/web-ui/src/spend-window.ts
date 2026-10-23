import { html, nothing } from "lit";

const DAY = 86400000;
const SPEND_PRESETS = new Map([
  ["7d", 7],
  ["30d", 30],
  ["90d", 90],
]);
const MAX_CUSTOM_DAYS = 366;

export interface SpendWindow {
  from: string;
  to: string;
  preset: string | null;
  bucket: "day" | "week";
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function dayMs(day: unknown): number | null {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && isoDay(ms) === day ? ms : null;
}

function windowOf(start: number, end: number, preset: string | null): SpendWindow {
  return { from: isoDay(start), to: isoDay(end), preset, bucket: end - start > 62 * DAY ? "week" : "day" };
}

export function spendWindow(
  state: { range?: string | null; from?: string | null; to?: string | null },
  now = Date.now(),
  maxDays = MAX_CUSTOM_DAYS,
): SpendWindow {
  const tomorrow = Math.floor(now / DAY) * DAY + DAY;
  const from = dayMs(state.from);
  const to = dayMs(state.to);
  const end = to === null ? null : Math.min(to, tomorrow);
  if (from !== null && end !== null && from < end) return windowOf(Math.max(from, end - maxDays * DAY), end, null);
  const preset = state.range && SPEND_PRESETS.has(state.range) ? state.range : "30d";
  return windowOf(tomorrow - SPEND_PRESETS.get(preset)! * DAY, tomorrow, preset);
}

export function lastSpendDay(window: { to: string }): string {
  return isoDay(Date.parse(window.to) - DAY);
}

export function spendAsOf(asOf: number): string {
  return `Totals as of ${new Date(asOf).toLocaleString()}. Updated every minute.`;
}

export function spendWindowTabs(
  current: SpendWindow,
  setRange: (range: string) => void,
  setCustomRange: (from: string, to: string) => void,
) {
  return [
    ...[...SPEND_PRESETS.keys()].map((range) => ({
      label: range,
      active: current.preset === range,
      onClick: () => setRange(range),
    })),
    { label: "Custom", active: current.preset === null, onClick: () => setCustomRange(current.from, current.to) },
  ];
}

export function spendCustomRange(
  current: SpendWindow,
  apply: (from: string, to: string) => void,
  maxDays = MAX_CUSTOM_DAYS,
) {
  if (current.preset !== null) return nothing;
  const today = isoDay(Date.now());
  const submit = (event: Event) => {
    event.preventDefault();
    const [first, last] = [...(event.currentTarget as HTMLFormElement).querySelectorAll("input")]
      .map((input) => input.value)
      .sort();
    const end = dayMs(last);
    if (dayMs(first) !== null && end !== null) apply(first!, isoDay(end + DAY));
  };
  return html`<form class="spend-custom" @submit=${submit}>
    <input type="date" aria-label="First day" required max=${today} .value=${current.from} />
    <span>to</span>
    <input type="date" aria-label="Last day" required max=${today} .value=${lastSpendDay(current)} />
    <button class="btn primary">Apply</button>
    <span class="hint">UTC, up to ${maxDays} days</span>
  </form>`;
}
