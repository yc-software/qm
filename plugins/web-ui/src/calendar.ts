import "./calendar.css";
import { html, nothing, render, type TemplateResult } from "lit";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide";
import { addDays, addWeeks, isSameMonth, isToday, startOfDay } from "date-fns";
import { ApiError, api } from "./core-bridge";
import { appState, replacePanePreservingFocus } from "./shell";
import { icon } from "./icons";
import { waveLoader } from "./ui";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { errMessage } from "../../chassis/src/errors";
import { listEvents, respond as sendReply, type CalendarEvent, type CalendarEvents, type Reply } from "./calendar-api";
import {
  dayBlocks,
  eventSpan,
  formatter,
  HOUR_ONLY,
  laneBars,
  LONG_DATE,
  SHORT_MONTH_YEAR,
  spansDays,
  timeLabel,
  timeRange,
  WEEKDAY,
  weekDays,
  whenLabel,
  type Bar,
  type Block,
  type Span,
} from "./calendar-layout";
import { popoverTpl, type Popover } from "./calendar-popover";
import { onSpeakerAvatars } from "./speaker-avatars";

const HOUR_PX = 48;
const MORNING_HOUR = 8;
const SHORT_MONTH = formatter({ month: "short" });

type Problem = { kind: "not_connected" | "reconnect" | "error"; message: string };

const cal = {
  anchor: startOfDay(new Date()),
  data: null as CalendarEvents | null,
  loading: false,
  problem: null as Problem | null,
  connecting: false,
  connectError: "",
  popover: null as Popover | null,
};
let host: HTMLElement | null = null;
let generation = 0;
let clock: ReturnType<typeof setInterval> | null = null;

export function renderCalendar(): void {
  if (appState.currentView !== "calendar" || !appState.mainEl) return;
  host = document.createElement("div");
  host.className = "pane content-wide-page calendar-page";
  cal.popover = null;
  draw();
  replacePanePreservingFocus(host);
  draw();
  void load();
  clock ??= setInterval(() => {
    if (host?.isConnected && appState.currentView === "calendar") draw();
  }, 60_000);
}

onSpeakerAvatars(() => {
  if (cal.popover) draw();
});

function draw(): void {
  if (!host || appState.currentView !== "calendar") return;
  render(pageTpl(), host);
  if (!host.isConnected) return;
  const scroller = host.querySelector<HTMLElement>(".cal-scroll");
  if (scroller && !scroller.dataset.placed) {
    scroller.dataset.placed = "1";
    scroller.scrollTop = MORNING_HOUR * HOUR_PX - HOUR_PX / 3;
  }
  placePopover();
}

async function load(): Promise<void> {
  const days = weekDays(cal.anchor);
  const current = ++generation;
  cal.loading = true;
  draw();
  try {
    const result = await listEvents(days[0]!.toISOString(), addDays(days[6]!, 1).toISOString());
    if (current !== generation) return;
    cal.data = result;
    cal.problem = null;
  } catch (cause) {
    if (current !== generation) return;
    cal.problem = problemOf(cause);
  } finally {
    if (current === generation) {
      cal.loading = false;
      draw();
    }
  }
}

function problemOf(cause: unknown): Problem {
  const body = cause instanceof ApiError ? (cause.body as { error?: string; reconnect?: boolean } | null) : null;
  const message = errMessage(cause, "Couldn't load your calendar.");
  if (body?.error === "not_connected") return { kind: "not_connected", message };
  if (body?.reconnect) return { kind: "reconnect", message };
  return { kind: "error", message };
}

function go(anchor: Date): void {
  cal.anchor = startOfDay(anchor);
  cal.data = null;
  cal.popover = null;
  draw();
  void load();
}

function spans(): Span[] {
  return (cal.data?.events ?? []).map(eventSpan);
}

function sameEvent(a: CalendarEvent, b: CalendarEvent): boolean {
  return a.id === b.id && a.calendarId === b.calendarId;
}

function replaceEvent(event: CalendarEvent, next: CalendarEvent): void {
  if (cal.data) cal.data.events = cal.data.events.map((item) => (sameEvent(item, event) ? next : item));
  if (cal.popover && sameEvent(cal.popover.event, event)) cal.popover = { ...cal.popover, event: next };
}

async function connectGoogle(): Promise<void> {
  cal.connecting = true;
  cal.connectError = "";
  draw();
  try {
    const result = await api<{ authorizeUrl?: string }>("/api/connectors/google/start", {
      method: "POST",
      body: JSON.stringify({ returnTo: deepLinkPath(UI_BASE, "calendar", null) }),
    });
    if (!result.authorizeUrl) throw new Error("Google didn't return a sign-in page.");
    location.href = result.authorizeUrl;
  } catch (cause) {
    cal.connectError = errMessage(cause, "Couldn't start connecting Google.");
    cal.connecting = false;
    draw();
  }
}

function openPopover(event: CalendarEvent, target: HTMLElement): void {
  cal.popover = { event, rect: target.getBoundingClientRect(), busy: false, error: "" };
  draw();
  host?.querySelector<HTMLElement>(".cal-pop")?.focus();
}

function closePopover(): void {
  if (!cal.popover) return;
  cal.popover = null;
  draw();
}

function placePopover(): void {
  const pop = host?.querySelector<HTMLElement>(".cal-pop");
  if (!pop || !cal.popover) return;
  const { rect } = cal.popover;
  const gap = 8;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const right = rect.right + gap;
  const left = right + width <= innerWidth - gap ? right : Math.max(gap, rect.left - gap - width);
  const top = Math.min(Math.max(gap, rect.top), Math.max(gap, innerHeight - height - gap));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

async function respond(status: Reply): Promise<void> {
  const pop = cal.popover;
  if (!pop || pop.busy) return;
  const before = pop.event;
  const optimistic: CalendarEvent = {
    ...before,
    selfResponse: status,
    attendees: before.attendees.map((person) => (person.self ? { ...person, responseStatus: status } : person)),
  };
  replaceEvent(before, optimistic);
  cal.popover = { ...cal.popover!, busy: true, error: "" };
  draw();
  try {
    replaceEvent(optimistic, await sendReply(before.calendarId, before.id, status));
    if (cal.popover) cal.popover.busy = false;
  } catch (cause) {
    replaceEvent(optimistic, before);
    if (cal.popover)
      cal.popover = { ...cal.popover, busy: false, error: errMessage(cause, "Couldn't send your reply.") };
  }
  draw();
}

function titleTpl(): TemplateResult {
  const days = weekDays(cal.anchor);
  const first = days[0]!;
  const last = days[6]!;
  if (isSameMonth(first, last))
    return html`${formatter({ month: "long" }).format(first)} <span class="cal-year">${first.getFullYear()}</span>`;
  return html`${
    first.getFullYear() === last.getFullYear()
      ? `${SHORT_MONTH.format(first)} – ${SHORT_MONTH_YEAR.format(last)}`
      : `${SHORT_MONTH_YEAR.format(first)} – ${SHORT_MONTH_YEAR.format(last)}`
  }`;
}

function zoneLabel(): string {
  return (
    formatter({ timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

function eventClass(event: CalendarEvent, end: Date): string {
  return [
    "cal-event",
    event.selfResponse === "declined" ? "is-declined" : "",
    event.selfResponse === "needsAction" ? "is-pending" : "",
    event.selfResponse === "tentative" ? "is-tentative" : "",
    end.getTime() < Date.now() ? "is-past" : "",
    cal.popover && sameEvent(cal.popover.event, event) ? "is-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function eventLabel(span: Span): string {
  return `${span.event.title || "(No title)"}, ${whenLabel(span)}`;
}

function onEventClick(event: CalendarEvent): (e: MouseEvent) => void {
  return (e) => {
    e.stopPropagation();
    if (cal.popover && sameEvent(cal.popover.event, event)) closePopover();
    else openPopover(event, e.currentTarget as HTMLElement);
  };
}

function pageTpl(): TemplateResult {
  const problem = cal.problem;
  if (problem && problem.kind !== "error")
    return html`<div class="pane-head"><h1 class="pane-title">Calendar</h1></div>
      ${connectTpl(problem)}`;
  return html`
    ${toolbarTpl()}
    <section class="cal-main" aria-busy=${cal.loading ? "true" : "false"}>
      ${
        problem
          ? html`<div class="inbox-notice cal-notice" role="alert">
              <span>${problem.message}</span>
              <button class="btn" type="button" @click=${() => void load()}>Retry</button>
            </div>`
          : nothing
      }
      ${gridTpl()}
    </section>
    ${cal.popover ? popoverTpl(cal.popover, cal.data?.calendars ?? [], { close: closePopover, respond: (status) => void respond(status) }) : nothing}
  `;
}

function toolbarTpl(): TemplateResult {
  const quiet = cal.data && !cal.loading && !cal.data.events.length;
  return html`<div class="pane-head cal-toolbar">
    <h1 class="pane-title cal-range" aria-live="polite">${titleTpl()}</h1>
    <div class="pane-head-actions">
      ${cal.loading ? waveLoader({ width: 13, height: 16, label: "Loading events", cls: "cal-loader" }) : nothing}
      ${quiet ? html`<span class="cal-quiet">Nothing scheduled this week</span>` : nothing}
      <button class="btn" type="button" @click=${() => go(new Date())}>Today</button>
      <span class="cal-steppers">
        <button
          class="icon-btn compact"
          type="button"
          aria-label="Previous week"
          @click=${() => go(addWeeks(cal.anchor, -1))}
        >
          ${icon(ChevronLeft, 16)}
        </button>
        <button
          class="icon-btn compact"
          type="button"
          aria-label="Next week"
          @click=${() => go(addWeeks(cal.anchor, 1))}
        >
          ${icon(ChevronRight, 16)}
        </button>
      </span>
    </div>
  </div>`;
}

function connectTpl(problem: Problem): TemplateResult {
  const reconnect = problem.kind === "reconnect";
  return html`<div class="cal-connect">
    <span class="cal-connect-icon">${icon(CalendarDays, 22)}</span>
    <h2>${reconnect ? "Reconnect Google Calendar" : "Connect Google Calendar"}</h2>
    <p>
      ${
        reconnect
          ? "Google stopped accepting QM's access to your calendar. Sign in again to see your schedule."
          : "See your schedule here, create events and answer invitations without leaving QM."
      }
    </p>
    <button class="btn primary" type="button" ?disabled=${cal.connecting} @click=${() => void connectGoogle()}>
      ${cal.connecting ? "Opening Google…" : `${reconnect ? "Reconnect" : "Connect"} Google`}
    </button>
    ${cal.connectError ? html`<p class="cal-connect-detail" role="alert">${cal.connectError}</p>` : nothing}
  </div>`;
}

function headerTpl(days: Date[]): TemplateResult {
  return html`<div class="cal-head">
    <div class="cal-gutter cal-zone">${zoneLabel()}</div>
    ${days.map(
      (day) =>
        html`<div
          class="cal-day-head ${isToday(day) ? "is-today" : ""} ${day < startOfDay(new Date()) ? "is-past" : ""}"
          aria-label=${LONG_DATE.format(day)}
        >
          <span class="cal-dow">${WEEKDAY.format(day)}</span>
          <span class="cal-date">${day.getDate()}</span>
        </div>`,
    )}
  </div>`;
}

function barTpl(bar: Bar, row: number): TemplateResult {
  const { event } = bar;
  return html`<button
    type="button"
    class="${eventClass(event, bar.end)} cal-bar ${bar.clippedStart ? "clip-start" : ""} ${bar.clippedEnd ? "clip-end" : ""}"
    style=${`--ev:${event.color};grid-column:${bar.col + 1} / span ${bar.span};grid-row:${row}`}
    aria-label=${eventLabel(bar)}
    @click=${onEventClick(event)}
  >
    ${event.allDay ? nothing : html`<span class="cal-event-time">${timeLabel(bar.start)}</span>`}
    <span class="cal-event-title">${event.title || "(No title)"}</span>
  </button>`;
}

function allDayTpl(bars: Bar[]): TemplateResult {
  const lanes = bars.reduce((most, bar) => Math.max(most, bar.lane + 1), 0);
  return html`<div class="cal-allday">
    <div class="cal-gutter cal-allday-label">All day</div>
    <div class="cal-allday-lanes" style=${`--lanes:${Math.max(1, lanes)}`}>
      ${bars.map((bar) => barTpl(bar, bar.lane + 1))}
    </div>
  </div>`;
}

function blockTpl(block: Block): TemplateResult {
  const { event } = block;
  const height = ((block.bottom - block.top) / 60) * HOUR_PX;
  const compact = height < 38;
  const left = block.col / block.cols;
  const width =
    block.col + block.width < block.cols
      ? Math.min((block.width / block.cols) * 1.7, 1 - left)
      : block.width / block.cols;
  return html`<button
    type="button"
    class="${eventClass(event, block.end)} cal-block ${compact ? "is-compact" : ""}"
    style=${`--ev:${event.color};top:${(block.top / 60) * HOUR_PX}px;height:${Math.max(height - 2, 16)}px;left:calc(${left * 100}% + 1px);width:calc(${width * 100}% - 6px);z-index:${block.col + 1}`}
    aria-label=${eventLabel(block)}
    @click=${onEventClick(event)}
  >
    <span class="cal-event-title">${event.title || "(No title)"}</span>
    <span class="cal-event-time">${compact ? timeLabel(block.start) : timeRange(block.start, block.end)}</span>
    ${!compact && event.location && height > 64 ? html`<span class="cal-event-where">${event.location}</span>` : nothing}
  </button>`;
}

function gridTpl(): TemplateResult {
  const days = weekDays(cal.anchor);
  const all = spans();
  const bars = laneBars(all.filter(spansDays), days);
  const now = new Date();
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const showNow = days.some((day) => isToday(day));
  return html`<div class="cal-grid cal-week" style=${`--days:7;--hour:${HOUR_PX}px`}>
    ${cal.loading ? html`<div class="cal-progress" aria-hidden="true"></div>` : nothing}
    <div class="cal-fixed">${headerTpl(days)} ${allDayTpl(bars)}</div>
    <div class="cal-scroll">
      <div class="cal-body">
        <div class="cal-gutter cal-hours" aria-hidden="true">
          ${hours.map(
            (hour) =>
              html`<span style=${`top:${hour * HOUR_PX}px`}
                >${hour && !(showNow && Math.abs(hour * HOUR_PX - nowTop) < HOUR_PX / 3) ? HOUR_ONLY.format(new Date(2000, 0, 1, hour)) : ""}</span
              >`,
          )}
          ${showNow ? html`<span class="cal-now-label" style=${`top:${nowTop}px`}>${timeLabel(now)}</span>` : nothing}
        </div>
        ${showNow ? html`<div class="cal-now-line" style=${`top:${nowTop - 0.5}px`} aria-hidden="true"></div>` : nothing}
        ${days.map(
          (day) =>
            html`<div
              class="cal-col ${isToday(day) ? "is-today" : ""}"
              role="group"
              aria-label=${LONG_DATE.format(day)}
            >
              ${dayBlocks(all, day).map(blockTpl)}
              ${isToday(day) ? html`<div class="cal-now" style=${`top:${nowTop}px`} aria-hidden="true"></div>` : nothing}
            </div>`,
        )}
      </div>
    </div>
  </div>`;
}

document.addEventListener("pointerdown", (e) => {
  if (!host?.isConnected || !cal.popover) return;
  if (!(e.target as Element | null)?.closest(".cal-pop, .cal-event")) closePopover();
});
