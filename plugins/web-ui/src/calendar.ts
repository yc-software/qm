import "./calendar.css";
import { html, nothing, render, type TemplateResult } from "lit";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide";
import {
  addDays,
  addMinutes,
  addMonths,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfHour,
  startOfMonth,
} from "date-fns";
import { ApiError, api } from "./core-bridge";
import { appState, replacePanePreservingFocus } from "./shell";
import { icon } from "./icons";
import { waveLoader } from "./ui";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { errMessage } from "../../chassis/src/errors";
import {
  deleteEvent,
  listEvents,
  updateEvent,
  type Calendar,
  type CalendarEvent,
  type CalendarEvents,
} from "./calendar-api";
import {
  CALENDAR_VIEWS,
  dayBlocks,
  eventSpan,
  formatter,
  HOUR_MINUTE,
  HOUR_ONLY,
  laneBars,
  LONG_DATE,
  MONTH_DAY,
  MONTH_YEAR,
  NARROW_WEEKDAY,
  SHORT_MONTH_YEAR,
  shiftAnchor,
  spansDays,
  timeLabel,
  visibleDays,
  WEEKDAY,
  whenLabel,
  type Bar,
  type Block,
  type CalendarView,
  type Span,
} from "./calendar-layout";
import { openEventEditor } from "./calendar-editor";
import { popoverTpl, type Popover, type Reply } from "./calendar-popover";

const HOUR_PX = 48;
const MORNING_HOUR = 8;
const MONTH_ROWS = 4;
const VIEW_KEY = "web-ui:calendar-view";
const HIDDEN_KEY = "web-ui:calendar-hidden";
const VIEW_LABELS: Record<CalendarView, string> = { day: "Day", week: "Week", month: "Month" };

type Problem = { kind: "not_connected" | "reconnect" | "error"; message: string };

interface Selection {
  day: Date;
  from: number;
  to: number;
  moved: boolean;
}

const cal = {
  view: storedView(),
  anchor: startOfDay(new Date()),
  miniMonth: startOfMonth(new Date()),
  cache: new Map<string, CalendarEvents>(),
  calendars: [] as Calendar[],
  hidden: storedHidden(),
  loading: "",
  problem: null as Problem | null,
  connecting: false,
  popover: null as Popover | null,
  selection: null as Selection | null,
};
let host: HTMLElement | null = null;
let generation = 0;
let clock: ReturnType<typeof setInterval> | null = null;

function storedView(): CalendarView {
  const stored = localStorage.getItem(VIEW_KEY);
  return CALENDAR_VIEWS.find((view) => view === stored) ?? "week";
}

function storedHidden(): Set<string> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function days(): Date[] {
  return visibleDays(cal.view, cal.anchor);
}

function rangeKey(range = days()): string {
  return `${range[0]!.toISOString()}/${addDays(range.at(-1)!, 1).toISOString()}`;
}

function currentData(): CalendarEvents | undefined {
  return cal.cache.get(rangeKey());
}

function visibleSpans(): Span[] {
  return (currentData()?.events ?? []).filter((event) => !cal.hidden.has(event.calendarId)).map(eventSpan);
}

export function renderCalendar(): void {
  if (appState.currentView !== "calendar" || !appState.mainEl) return;
  host = document.createElement("div");
  host.className = "pane content-wide-page calendar-page";
  cal.popover = null;
  cal.selection = null;
  draw();
  replacePanePreservingFocus(host);
  draw();
  void load();
  clock ??= setInterval(() => {
    if (host?.isConnected && appState.currentView === "calendar") draw();
  }, 60_000);
}

function draw(): void {
  if (!host || appState.currentView !== "calendar") return;
  render(pageTpl(), host);
  if (!host.isConnected) return;
  const scroller = host.querySelector<HTMLElement>(".cal-scroll");
  if (scroller && !scroller.dataset.placed) {
    scroller.dataset.placed = "1";
    scroller.scrollTop = MORNING_HOUR * HOUR_PX - 8;
  }
  placePopover();
}

async function load(force = false): Promise<void> {
  const range = days();
  const key = rangeKey(range);
  if (!force && (cal.cache.has(key) || cal.loading === key)) return;
  const current = ++generation;
  cal.loading = key;
  draw();
  try {
    const result = await listEvents(range[0]!.toISOString(), addDays(range.at(-1)!, 1).toISOString());
    if (current !== generation) return;
    cal.cache.set(key, result);
    cal.calendars = result.calendars;
    cal.problem = null;
  } catch (cause) {
    if (current !== generation) return;
    cal.problem = problemOf(cause);
  } finally {
    if (current === generation) {
      cal.loading = "";
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

function go(next: { view?: CalendarView; anchor?: Date }): void {
  if (next.view && next.view !== cal.view) {
    cal.view = next.view;
    localStorage.setItem(VIEW_KEY, next.view);
  }
  if (next.anchor) {
    cal.anchor = startOfDay(next.anchor);
    cal.miniMonth = startOfMonth(next.anchor);
  }
  cal.popover = null;
  cal.problem = cal.problem?.kind === "error" ? null : cal.problem;
  draw();
  void load();
}

function step(direction: number): void {
  go({ anchor: shiftAnchor(cal.view, cal.anchor, direction) });
}

function toggleCalendar(id: string): void {
  if (!cal.hidden.delete(id)) cal.hidden.add(id);
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...cal.hidden]));
  if (cal.popover && cal.hidden.has(cal.popover.event.calendarId)) cal.popover = null;
  draw();
}

function sameEvent(a: CalendarEvent, b: CalendarEvent): boolean {
  return a.id === b.id && a.calendarId === b.calendarId;
}

function replaceEvent(event: CalendarEvent, next: CalendarEvent | null): void {
  for (const data of cal.cache.values()) {
    const kept = data.events.filter((item) => !sameEvent(item, event));
    if (next) kept.push(next);
    data.events = kept.sort((a, b) => a.start.localeCompare(b.start));
  }
  if (cal.popover && sameEvent(cal.popover.event, event)) cal.popover = next ? { ...cal.popover, event: next } : null;
}

function saved(event: CalendarEvent): void {
  replaceEvent(event, event);
  refreshAfterEdit();
}

function removed(event: CalendarEvent): void {
  replaceEvent(event, null);
  refreshAfterEdit();
}

function refreshAfterEdit(): void {
  const key = rangeKey();
  for (const other of [...cal.cache.keys()]) if (other !== key) cal.cache.delete(other);
  draw();
  void load(true);
}

function openEditor(options: {
  initial?: CalendarEvent;
  draft?: { start: string; end: string; allDay: boolean };
}): void {
  cal.popover = null;
  draw();
  openEventEditor({ ...options, calendars: cal.calendars, onSaved: saved, onDeleted: removed });
}

function createAt(start: Date, end: Date, allDay: boolean): void {
  openEditor({
    draft: allDay
      ? { start: format(start, "yyyy-MM-dd"), end: format(end, "yyyy-MM-dd"), allDay }
      : { start: start.toISOString(), end: end.toISOString(), allDay },
  });
}

function createNow(): void {
  const now = new Date();
  const base = isSameDay(cal.anchor, now) ? now : addMinutes(cal.anchor, MORNING_HOUR * 60);
  const start = addMinutes(startOfHour(base), isSameDay(cal.anchor, now) ? 60 : 0);
  createAt(start, addMinutes(start, 60), false);
}

async function connectGoogle(): Promise<void> {
  cal.connecting = true;
  draw();
  try {
    const result = await api<{ authorizeUrl?: string }>("/api/connectors/google/start", {
      method: "POST",
      body: JSON.stringify({ returnTo: deepLinkPath(UI_BASE, "calendar", null) }),
    });
    if (!result.authorizeUrl) throw new Error("Google didn't return a sign-in page.");
    location.href = result.authorizeUrl;
  } catch (cause) {
    cal.problem = {
      kind: cal.problem?.kind ?? "not_connected",
      message: errMessage(cause, "Couldn't start connecting Google."),
    };
    cal.connecting = false;
    draw();
  }
}

function openPopover(event: CalendarEvent, target: HTMLElement): void {
  cal.popover = { event, rect: target.getBoundingClientRect(), busy: false, error: "", confirmDelete: false };
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
    replaceEvent(optimistic, await updateEvent(before.calendarId, before.id, { responseStatus: status }));
    if (cal.popover) cal.popover.busy = false;
  } catch (cause) {
    replaceEvent(optimistic, before);
    if (cal.popover)
      cal.popover = { ...cal.popover, busy: false, error: errMessage(cause, "Couldn't send your reply.") };
  }
  draw();
}

async function removeEvent(): Promise<void> {
  const pop = cal.popover;
  if (!pop || pop.busy) return;
  cal.popover = { ...pop, busy: true, error: "" };
  draw();
  try {
    await deleteEvent(pop.event.calendarId, pop.event.id);
    removed(pop.event);
  } catch (cause) {
    if (cal.popover)
      cal.popover = { ...cal.popover, busy: false, error: errMessage(cause, "Couldn't delete this event.") };
    draw();
  }
}

function rangeLabel(): string {
  const shown = days();
  if (cal.view === "day") return LONG_DATE.format(cal.anchor);
  if (cal.view === "month") return MONTH_YEAR.format(cal.anchor);
  const first = shown[0]!;
  const last = shown.at(-1)!;
  if (isSameMonth(first, last)) return MONTH_YEAR.format(first);
  return first.getFullYear() === last.getFullYear()
    ? `${formatter({ month: "short" }).format(first)} – ${SHORT_MONTH_YEAR.format(last)}`
    : `${SHORT_MONTH_YEAR.format(first)} – ${SHORT_MONTH_YEAR.format(last)}`;
}

function zoneLabel(): string {
  return (
    formatter({ timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

function emptyNote(): string {
  if (cal.view === "day") return isToday(cal.anchor) ? "Nothing scheduled today" : "Nothing scheduled";
  return cal.view === "week" ? "Nothing scheduled this week" : "Nothing scheduled this month";
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
  const blocked = problem && problem.kind !== "error";
  return html`
    <div class="pane-head">
      <h1 class="pane-title">Calendar</h1>
      <div class="pane-head-actions">
        <button class="btn primary" type="button" ?disabled=${Boolean(blocked)} @click=${createNow}>
          ${icon(Plus, 14)}<span>Create</span>
        </button>
      </div>
    </div>
    <div class="cal-shell">
      ${blocked ? nothing : railTpl()}
      <section class="cal-main" aria-busy=${cal.loading ? "true" : "false"}>
        ${toolbarTpl(Boolean(blocked))}
        ${
          problem?.kind === "error"
            ? html`<div class="inbox-notice cal-notice" role="alert">
                ${problem.message} <button class="btn" type="button" @click=${() => void load(true)}>Try again</button>
              </div>`
            : nothing
        }
        ${blocked ? connectTpl(problem) : viewTpl()}
      </section>
    </div>
    ${
      cal.popover
        ? popoverTpl(cal.popover, cal.calendars, {
            close: closePopover,
            edit: (event) => openEditor({ initial: event }),
            confirmDelete: (asking) => {
              if (cal.popover) cal.popover = { ...cal.popover, confirmDelete: asking, error: "" };
              draw();
            },
            remove: () => void removeEvent(),
            respond: (status) => void respond(status),
          })
        : nothing
    }
  `;
}

function viewTpl(): TemplateResult {
  return cal.view === "month" ? monthTpl() : timeGridTpl();
}

function toolbarTpl(blocked: boolean): TemplateResult {
  const data = currentData();
  const quiet = data && !cal.loading && !visibleSpans().length;
  return html`<div class="cal-toolbar">
    <button class="btn" type="button" ?disabled=${blocked} @click=${() => go({ anchor: new Date() })} title="Today (T)">
      Today
    </button>
    <span class="cal-steppers">
      <button
        class="icon-btn compact"
        type="button"
        ?disabled=${blocked}
        aria-label=${`Previous ${cal.view}`}
        title="Previous (K)"
        @click=${() => step(-1)}
      >
        ${icon(ChevronLeft, 16)}
      </button>
      <button
        class="icon-btn compact"
        type="button"
        ?disabled=${blocked}
        aria-label=${`Next ${cal.view}`}
        title="Next (J)"
        @click=${() => step(1)}
      >
        ${icon(ChevronRight, 16)}
      </button>
    </span>
    <h2 class="cal-range" aria-live="polite">${rangeLabel()}</h2>
    ${cal.loading && !blocked ? waveLoader({ width: 13, height: 16, label: "Loading events", cls: "cal-loader" }) : nothing}
    ${quiet && !blocked ? html`<span class="cal-quiet">${emptyNote()}</span>` : nothing}
    <div class="cron-segments cal-views" role="radiogroup" aria-label="Calendar view">
      ${CALENDAR_VIEWS.map(
        (view) =>
          html`<button
            type="button"
            role="radio"
            aria-checked=${cal.view === view}
            class=${cal.view === view ? "active" : ""}
            title=${`${VIEW_LABELS[view]} (${view[0]!.toUpperCase()})`}
            ?disabled=${blocked}
            @click=${() => go({ view })}
          >
            ${VIEW_LABELS[view]}
          </button>`,
      )}
    </div>
  </div>`;
}

function railTpl(): TemplateResult {
  const first = visibleDays("month", cal.miniMonth);
  const shown = days();
  return html`<aside class="cal-rail" aria-label="Calendars">
    <div class="cal-mini">
      <div class="cal-mini-head">
        <span>${MONTH_YEAR.format(cal.miniMonth)}</span>
        <button
          class="icon-btn compact subtle"
          type="button"
          aria-label="Previous month"
          @click=${() => {
            cal.miniMonth = addMonths(cal.miniMonth, -1);
            draw();
          }}
        >
          ${icon(ChevronLeft, 14)}
        </button>
        <button
          class="icon-btn compact subtle"
          type="button"
          aria-label="Next month"
          @click=${() => {
            cal.miniMonth = addMonths(cal.miniMonth, 1);
            draw();
          }}
        >
          ${icon(ChevronRight, 14)}
        </button>
      </div>
      <div class="cal-mini-grid" role="grid">
        ${first.slice(0, 7).map((day) => html`<span class="cal-mini-dow" aria-hidden="true">${NARROW_WEEKDAY.format(day)}</span>`)}
        ${first.map((day) => {
          const inRange = cal.view !== "month" && day >= shown[0]! && day <= shown.at(-1)!;
          return html`<button
            type="button"
            class="cal-mini-day ${isSameMonth(day, cal.miniMonth) ? "" : "is-outside"} ${isToday(day) ? "is-today" : ""} ${inRange ? "is-range" : ""} ${isSameDay(day, cal.anchor) ? "is-anchor" : ""}"
            aria-label=${LONG_DATE.format(day)}
            @click=${() => go({ anchor: day })}
          >
            ${day.getDate()}
          </button>`;
        })}
      </div>
    </div>
    ${
      cal.calendars.length
        ? html`<div class="cal-list">
            <div class="cal-list-head">My calendars</div>
            ${cal.calendars.map(
              (calendar) =>
                html`<label class="cal-list-item" style=${`--ev:${calendar.color}`} title=${calendar.name}>
                  <input
                    type="checkbox"
                    .checked=${!cal.hidden.has(calendar.id)}
                    @change=${() => toggleCalendar(calendar.id)}
                  />
                  <span>${calendar.name}</span>
                </label>`,
            )}
          </div>`
        : nothing
    }
  </aside>`;
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
    ${cal.connecting || problem.message === "" || problem.kind === "not_connected" ? nothing : html`<p class="cal-connect-detail" role="alert">${problem.message}</p>`}
  </div>`;
}

function headerTpl(shown: Date[]): TemplateResult {
  return html`<div class="cal-head">
    <div class="cal-gutter cal-zone">${zoneLabel()}</div>
    ${shown.map(
      (day) =>
        html`<button
          type="button"
          class="cal-day-head ${isToday(day) ? "is-today" : ""} ${day < startOfDay(new Date()) ? "is-past" : ""}"
          aria-label=${`Show ${LONG_DATE.format(day)}`}
          @click=${() => go({ view: "day", anchor: day })}
        >
          <span class="cal-dow">${WEEKDAY.format(day)}</span>
          <span class="cal-date">${day.getDate()}</span>
        </button>`,
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

function allDayTpl(shown: Date[], bars: Bar[]): TemplateResult {
  const lanes = bars.reduce((most, bar) => Math.max(most, bar.lane + 1), 0);
  return html`<div class="cal-allday">
    <div class="cal-gutter cal-allday-label">All day</div>
    <div class="cal-allday-lanes" style=${`--lanes:${Math.max(1, lanes)}`}>
      ${shown.map(
        (day, index) =>
          html`<div
            class="cal-allday-cell"
            style=${`grid-column:${index + 1};grid-row:1 / -1`}
            @click=${() => createAt(day, addDays(day, 1), true)}
          ></div>`,
      )}
      ${bars.map((bar) => barTpl(bar, bar.lane + 1))}
    </div>
  </div>`;
}

function blockTpl(block: Block): TemplateResult {
  const { event } = block;
  const height = ((block.bottom - block.top) / 60) * HOUR_PX;
  const compact = height < 38;
  return html`<button
    type="button"
    class="${eventClass(event, block.end)} cal-block ${compact ? "is-compact" : ""}"
    style=${`--ev:${event.color};top:${(block.top / 60) * HOUR_PX}px;height:${Math.max(height - 2, 16)}px;left:calc(${(block.col / block.cols) * 100}% + 1px);width:calc(${(block.width / block.cols) * 100}% - ${block.col + block.width < block.cols ? 4 : 6}px)`}
    aria-label=${eventLabel(block)}
    @click=${onEventClick(event)}
    @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
  >
    <span class="cal-event-title">${event.title || "(No title)"}</span>
    <span class="cal-event-time"
      >${compact ? timeLabel(block.start) : HOUR_MINUTE.formatRange(block.start, block.end)}</span
    >
    ${!compact && event.location && height > 64 ? html`<span class="cal-event-where">${event.location}</span>` : nothing}
  </button>`;
}

function minuteAt(column: HTMLElement, clientY: number): number {
  const offset = clientY - column.getBoundingClientRect().top;
  return Math.min(24 * 60, Math.max(0, Math.round(((offset / HOUR_PX) * 60) / 15) * 15));
}

function startSelection(day: Date, e: PointerEvent): void {
  if (e.button !== 0 || cal.problem?.kind === "not_connected") return;
  if (cal.popover) {
    closePopover();
    return;
  }
  const column = e.currentTarget as HTMLElement;
  const at = Math.min(minuteAt(column, e.clientY - 7), 24 * 60 - 15);
  column.setPointerCapture(e.pointerId);
  cal.selection = { day, from: at, to: at + 15, moved: false };
  draw();
}

function moveSelection(e: PointerEvent): void {
  const selection = cal.selection;
  if (!selection) return;
  const at = minuteAt(e.currentTarget as HTMLElement, e.clientY);
  const anchor = selection.from;
  const to = Math.max(anchor + 15, at);
  if (to === selection.to) return;
  cal.selection = { ...selection, to, moved: true };
  draw();
}

function endSelection(): void {
  const selection = cal.selection;
  if (!selection) return;
  cal.selection = null;
  const from = selection.moved ? selection.from : Math.floor(selection.from / 30) * 30;
  const to = selection.moved ? selection.to : from + 60;
  createAt(addMinutes(selection.day, from), addMinutes(selection.day, to), false);
}

function timeGridTpl(): TemplateResult {
  const shown = days();
  const spans = visibleSpans();
  const bars = laneBars(spans.filter(spansDays), shown);
  const now = new Date();
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return html`<div class="cal-grid cal-${cal.view}" style=${`--days:${shown.length};--hour:${HOUR_PX}px`}>
    ${cal.loading ? html`<div class="cal-progress" aria-hidden="true"></div>` : nothing}
    <div class="cal-fixed">${headerTpl(shown)} ${allDayTpl(shown, bars)}</div>
    <div class="cal-scroll">
      <div class="cal-body">
        <div class="cal-gutter cal-hours" aria-hidden="true">
          ${hours.map((hour) => html`<span style=${`top:${hour * HOUR_PX}px`}>${hour ? HOUR_ONLY.format(new Date(2000, 0, 1, hour)) : ""}</span>`)}
        </div>
        ${shown.map((day) => {
          const selection = cal.selection && isSameDay(cal.selection.day, day) ? cal.selection : null;
          return html`<div
            class="cal-col ${isToday(day) ? "is-today" : ""}"
            role="group"
            aria-label=${LONG_DATE.format(day)}
            @pointerdown=${(e: PointerEvent) => startSelection(day, e)}
            @pointermove=${moveSelection}
            @pointerup=${endSelection}
            @pointercancel=${() => {
              cal.selection = null;
              draw();
            }}
          >
            ${dayBlocks(spans, day).map(blockTpl)}
            ${
              selection
                ? html`<div
                    class="cal-ghost"
                    style=${`top:${(selection.from / 60) * HOUR_PX}px;height:${((selection.to - selection.from) / 60) * HOUR_PX - 2}px`}
                  >
                    <span class="cal-event-title">(No title)</span>
                    <span class="cal-event-time"
                      >${HOUR_MINUTE.formatRange(addMinutes(day, selection.from), addMinutes(day, selection.to))}</span
                    >
                  </div>`
                : nothing
            }
            ${isToday(day) ? html`<div class="cal-now" style=${`top:${nowTop}px`} aria-hidden="true"></div>` : nothing}
          </div>`;
        })}
      </div>
    </div>
  </div>`;
}

function monthTpl(): TemplateResult {
  const shown = days();
  const spans = visibleSpans();
  const weeks = Array.from({ length: shown.length / 7 }, (_, index) => shown.slice(index * 7, index * 7 + 7));
  return html`<div class="cal-grid cal-month" style=${`--weeks:${weeks.length}`}>
    ${cal.loading ? html`<div class="cal-progress" aria-hidden="true"></div>` : nothing}
    <div class="cal-month-head">${weeks[0]!.map((day) => html`<span>${WEEKDAY.format(day)}</span>`)}</div>
    <div class="cal-month-body">${weeks.map((week) => weekRowTpl(week, spans))}</div>
  </div>`;
}

function weekRowTpl(week: Date[], spans: Span[]): TemplateResult {
  const bars = laneBars(spans.filter(spansDays), week);
  const taken = week.map(() => new Set<number>());
  for (const bar of bars) for (let col = bar.col; col < bar.col + bar.span; col++) taken[col]!.add(bar.lane);
  const chips = week.flatMap((day, col) =>
    spans
      .filter((span) => !spansDays(span) && isSameDay(span.start, day))
      .map((span) => {
        let row = 0;
        while (taken[col]!.has(row)) row++;
        taken[col]!.add(row);
        return { span, col, row };
      }),
  );
  const limit = MONTH_ROWS - 1;
  const overflow = taken.map((rows) => (rows.size > MONTH_ROWS ? [...rows].filter((row) => row >= limit).length : 0));
  const fits = (row: number, cols: number[]): boolean =>
    row < limit || cols.every((col) => overflow[col] === 0 && row < MONTH_ROWS);
  return html`<div class="cal-week-row">
    ${week.map(
      (day, col) =>
        html`<div
          class="cal-month-cell ${isSameMonth(day, cal.anchor) ? "" : "is-outside"} ${isToday(day) ? "is-today" : ""}"
          style=${`grid-column:${col + 1}`}
          @click=${() => createAt(day, addDays(day, 1), true)}
        >
          <button
            type="button"
            class="cal-month-date"
            aria-label=${`Show ${LONG_DATE.format(day)}`}
            @click=${(e: Event) => {
              e.stopPropagation();
              go({ view: "day", anchor: day });
            }}
          >
            ${day.getDate() === 1 ? MONTH_DAY.format(day) : day.getDate()}
          </button>
        </div>`,
    )}
    ${bars
      .filter((bar) =>
        fits(
          bar.lane,
          Array.from({ length: bar.span }, (_, offset) => bar.col + offset),
        ),
      )
      .map((bar) => barTpl(bar, bar.lane + 2))}
    ${chips
      .filter((chip) => fits(chip.row, [chip.col]))
      .map(
        ({ span, col, row }) =>
          html`<button
            type="button"
            class="${eventClass(span.event, span.end)} cal-chip"
            style=${`--ev:${span.event.color};grid-column:${col + 1};grid-row:${row + 2}`}
            aria-label=${eventLabel(span)}
            @click=${onEventClick(span.event)}
          >
            <span class="cal-chip-dot"></span>
            <span class="cal-event-time">${timeLabel(span.start)}</span>
            <span class="cal-event-title">${span.event.title || "(No title)"}</span>
          </button>`,
      )}
    ${overflow.map((count, col) =>
      count
        ? html`<button
            type="button"
            class="cal-more"
            style=${`grid-column:${col + 1};grid-row:${MONTH_ROWS + 1}`}
            @click=${() => go({ view: "day", anchor: week[col]! })}
          >
            ${count} more
          </button>`
        : nothing,
    )}
  </div>`;
}

document.addEventListener("pointerdown", (e) => {
  if (!cal.popover || !host?.isConnected) return;
  const target = e.target as Element | null;
  if (target?.closest(".cal-pop, .cal-event, .cal-col")) return;
  closePopover();
});

document.addEventListener("keydown", (e) => {
  if (appState.currentView !== "calendar" || !host?.isConnected || e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as Element | null;
  if (
    target?.closest("input, textarea, select, [contenteditable]") ||
    document.querySelector("dialog[open], [aria-modal='true']")
  )
    return;
  if (e.key === "Escape") {
    closePopover();
    return;
  }
  if (cal.problem && cal.problem.kind !== "error") return;
  const actions: Record<string, () => void> = {
    t: () => go({ anchor: new Date() }),
    d: () => go({ view: "day" }),
    w: () => go({ view: "week" }),
    m: () => go({ view: "month" }),
    j: () => step(1),
    n: () => step(1),
    ArrowRight: () => step(1),
    k: () => step(-1),
    p: () => step(-1),
    ArrowLeft: () => step(-1),
    c: createNow,
  };
  const action = actions[e.key];
  if (!action) return;
  e.preventDefault();
  action();
});
