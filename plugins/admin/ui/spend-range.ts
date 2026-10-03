import { html } from "lit";

const DAY = 86400000;
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export interface SpendWindow {
  from: string;
  to: string;
}

export interface RangePickerOptions {
  month: number;
  window: SpendWindow | null;
  pending: string | null;
  today: string;
  onPick: (day: string) => void;
  onShift: (delta: number) => void;
  onClose: () => void;
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const formatDay = (day: string, options: Intl.DateTimeFormatOptions) =>
  new Date(dayMs(day)).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });

export const nextDay = (day: string) => isoDay(dayMs(day) + DAY);
export const previousDay = (day: string) => isoDay(dayMs(day) - DAY);

export function monthStart(day: string): number {
  const date = new Date(dayMs(day));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function shiftMonth(month: number, delta: number): number {
  const date = new Date(month);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1);
}

function monthDays(month: number): (string | null)[] {
  const date = new Date(month);
  const count = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return [
    ...Array.from({ length: date.getUTCDay() }, () => null),
    ...Array.from({ length: count }, (_, i) => isoDay(month + i * DAY)),
  ];
}

export function windowLabel(window: SpendWindow, today: string): string {
  const last = previousDay(window.to);
  const year = (day: string) => day.slice(0, 4);
  const month = (day: string) => formatDay(day, { month: "short" });
  const dayOfMonth = (day: string) => String(Number(day.slice(8)));
  const crossesYear = year(window.from) !== year(last);
  const suffix = crossesYear || year(last) !== year(today) ? `, ${year(last)}` : "";
  if (window.from === last) return `${month(last)} ${dayOfMonth(last)}${suffix}`;
  if (window.from.slice(0, 7) === last.slice(0, 7))
    return `${month(last)} ${dayOfMonth(window.from)}–${dayOfMonth(last)}${suffix}`;
  const start = `${month(window.from)} ${dayOfMonth(window.from)}${crossesYear ? `, ${year(window.from)}` : ""}`;
  return `${start} – ${month(last)} ${dayOfMonth(last)}${suffix}`;
}

export function rangePicker(options: RangePickerOptions) {
  const first = options.pending ?? options.window?.from ?? null;
  const last = options.pending ?? (options.window ? previousDay(options.window.to) : null);
  const latestMonth = monthStart(options.today);
  const dayClass = (day: string) =>
    [
      "spend-range-day",
      first !== null && last !== null && day >= first && day <= last ? "in-range" : "",
      day === first || day === last ? "edge" : "",
      day === options.today ? "today" : "",
    ]
      .filter(Boolean)
      .join(" ");
  const heading = (month: number, side: "previous" | "next") =>
    html`<div class="spend-range-head">
      ${
        side === "previous"
          ? html`<button
              type="button"
              class="spend-range-nav"
              aria-label="Previous month"
              @click=${() => options.onShift(-1)}
            >
              ‹
            </button>`
          : html`<span></span>`
      }
      <div class="spend-range-title">
        ${new Date(month).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}
      </div>
      ${
        side === "next"
          ? html`<button
              type="button"
              class="spend-range-nav"
              aria-label="Next month"
              ?disabled=${month >= latestMonth}
              @click=${() => options.onShift(1)}
            >
              ›
            </button>`
          : html`<span></span>`
      }
    </div>`;
  return html`<div class="spend-range-backdrop" @click=${options.onClose}></div>
    <div
      class="spend-range"
      role="dialog"
      aria-label="Custom date range"
      tabindex="-1"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") options.onClose();
      }}
    >
      <div class="spend-range-months">
        ${[shiftMonth(options.month, -1), options.month].map(
          (month, index) =>
            html`<section class="spend-range-month">
              ${heading(month, index === 0 ? "previous" : "next")}
              <div class="spend-range-grid">
                ${WEEKDAYS.map((label) => html`<span class="spend-range-weekday" aria-hidden="true">${label}</span>`)}
                ${monthDays(month).map((day) =>
                  day === null
                    ? html`<span></span>`
                    : html`<button
                        type="button"
                        class=${dayClass(day)}
                        aria-label=${formatDay(day, { month: "long", day: "numeric", year: "numeric" })}
                        aria-pressed=${String(day === first || day === last)}
                        ?disabled=${day > options.today}
                        @click=${() => options.onPick(day)}
                      >
                        ${Number(day.slice(8))}
                      </button>`,
                )}
              </div>
            </section>`,
        )}
      </div>
      <p class="spend-range-hint">${options.pending ? "Choose the last day" : "Choose the first day"} · UTC</p>
    </div>`;
}
