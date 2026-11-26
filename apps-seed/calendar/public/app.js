import {
  addDays,
  dayBlocks,
  eventSpan,
  formatter,
  HOUR_ONLY,
  laneBars,
  LONG_DATE,
  SHORT_MONTH_YEAR,
  spansDays,
  startOfDay,
  timeLabel,
  timeRange,
  WEEKDAY,
  weekDays,
  whenLabel,
} from "./layout.js";

const HOUR_PX = 48;
const MORNING_HOUR = 8;
const SHORT_MONTH = formatter({ month: "short" });
const LONG_MONTH = formatter({ month: "long" });
const REPLIES = [
  ["accepted", "Yes"],
  ["declined", "No"],
  ["tentative", "Maybe"],
];
const ICONS = {
  chevronLeft: ['<path d="m15 18-6-6 6-6"/>'],
  chevronRight: ['<path d="m9 18 6-6-6-6"/>'],
  arrowUpRight: ['<path d="M7 7h10v10"/>', '<path d="M7 17 17 7"/>'],
  x: ['<path d="M18 6 6 18"/>', '<path d="m6 6 12 12"/>'],
  check: ['<path d="M20 6 9 17l-5-5"/>'],
  help: [
    '<circle cx="12" cy="12" r="10"/>',
    '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>',
    '<path d="M12 17h.01"/>',
  ],
  video: [
    '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/>',
    '<rect x="2" y="6" width="14" height="12" rx="2"/>',
  ],
  mapPin: [
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/>',
    '<circle cx="12" cy="10" r="3"/>',
  ],
  users: [
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>',
    '<circle cx="9" cy="7" r="4"/>',
    '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  ],
  text: ['<path d="M15 12H3"/>', '<path d="M17 18H3"/>', '<path d="M21 6H3"/>'],
  calendar: [
    '<path d="M8 2v4"/>',
    '<path d="M16 2v4"/>',
    '<rect width="18" height="18" x="3" y="4" rx="2"/>',
    '<path d="M3 10h18"/>',
  ],
};

const state = { anchor: startOfDay(new Date()), data: null, loading: false, problem: null, popover: null };
let generation = 0;

const theme = new URLSearchParams(location.search).get("theme");
const prefersDark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.classList.toggle("dark", theme ? theme === "dark" : prefersDark.matches);
applyTheme();
prefersDark.addEventListener("change", applyTheme);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "style") el.style.cssText = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  return el;
}

function icon(name, size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name].join("");
  return svg;
}

async function call(path, init) {
  const resp = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(body.message ?? `Request failed (${resp.status})`), { body });
  return body;
}

function problemOf(cause) {
  const message = cause.message || "Couldn't load your calendar.";
  if (cause.body?.error === "not_connected") return { kind: "not_connected", message };
  if (cause.body?.reconnect) return { kind: "reconnect", message };
  return { kind: "error", message };
}

async function load() {
  const days = weekDays(state.anchor);
  const current = ++generation;
  state.loading = true;
  draw();
  try {
    const query = new URLSearchParams({ timeMin: days[0].toISOString(), timeMax: addDays(days[6], 1).toISOString() });
    const result = await call(`api/events?${query}`);
    if (current !== generation) return;
    state.data = result;
    state.problem = null;
  } catch (cause) {
    if (current !== generation) return;
    state.problem = problemOf(cause);
  } finally {
    if (current === generation) {
      state.loading = false;
      draw();
    }
  }
}

function go(anchor) {
  state.anchor = startOfDay(anchor);
  state.data = null;
  state.popover = null;
  void load();
}

const sameEvent = (a, b) => a.id === b.id && a.calendarId === b.calendarId;

function replaceEvent(event, next) {
  if (state.data) state.data.events = state.data.events.map((item) => (sameEvent(item, event) ? next : item));
  if (state.popover && sameEvent(state.popover.event, event)) state.popover = { ...state.popover, event: next };
}

async function respond(status) {
  const pop = state.popover;
  if (!pop || pop.busy) return;
  const before = pop.event;
  const optimistic = {
    ...before,
    selfResponse: status,
    attendees: before.attendees.map((person) => (person.self ? { ...person, responseStatus: status } : person)),
  };
  replaceEvent(before, optimistic);
  state.popover = { ...state.popover, busy: true, error: "" };
  draw();
  try {
    const path = `api/events/${encodeURIComponent(before.calendarId)}/${encodeURIComponent(before.id)}`;
    replaceEvent(optimistic, await call(path, { method: "PATCH", body: JSON.stringify({ responseStatus: status }) }));
    if (state.popover) state.popover.busy = false;
  } catch (cause) {
    replaceEvent(optimistic, before);
    if (state.popover)
      state.popover = { ...state.popover, busy: false, error: cause.message || "Couldn't send your reply." };
  }
  draw();
}

function askHostToConnect() {
  window.parent.postMessage({ type: "qm:connect", connector: "google" }, "*");
}

function titleNodes() {
  const days = weekDays(state.anchor);
  const [first, last] = [days[0], days[6]];
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear())
    return [`${LONG_MONTH.format(first)} `, h("span", { class: "cal-year" }, String(first.getFullYear()))];
  return [
    first.getFullYear() === last.getFullYear()
      ? `${SHORT_MONTH.format(first)} – ${SHORT_MONTH_YEAR.format(last)}`
      : `${SHORT_MONTH_YEAR.format(first)} – ${SHORT_MONTH_YEAR.format(last)}`,
  ];
}

function zoneLabel() {
  return (
    formatter({ timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? ""
  );
}

function eventClass(event, end) {
  return [
    "cal-event",
    event.selfResponse === "declined" && "is-declined",
    event.selfResponse === "needsAction" && "is-pending",
    event.selfResponse === "tentative" && "is-tentative",
    end.getTime() < Date.now() && "is-past",
    state.popover && sameEvent(state.popover.event, event) && "is-open",
  ]
    .filter(Boolean)
    .join(" ");
}

function onEventClick(event) {
  return (e) => {
    e.stopPropagation();
    state.popover =
      state.popover && sameEvent(state.popover.event, event)
        ? null
        : { event, rect: e.currentTarget.getBoundingClientRect(), busy: false, error: "" };
    draw();
    document.querySelector(".cal-pop")?.focus();
  };
}

const isToday = (day) => startOfDay(day).getTime() === startOfDay(new Date()).getTime();
const titleOf = (event) => event.title || "(No title)";

function toolbar() {
  const quiet = state.data && !state.loading && !state.data.events.length;
  return h(
    "div",
    { class: "pane-head cal-toolbar" },
    h("h1", { class: "pane-title cal-range", "aria-live": "polite" }, titleNodes()),
    h(
      "div",
      { class: "pane-head-actions" },
      quiet && h("span", { class: "cal-quiet" }, "Nothing scheduled this week"),
      h("button", { class: "btn", type: "button", onclick: () => go(new Date()) }, "Today"),
      h(
        "span",
        { class: "cal-steppers" },
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            "aria-label": "Previous week",
            onclick: () => go(addDays(state.anchor, -7)),
          },
          icon("chevronLeft", 16),
        ),
        h(
          "button",
          { class: "icon-btn", type: "button", "aria-label": "Next week", onclick: () => go(addDays(state.anchor, 7)) },
          icon("chevronRight", 16),
        ),
      ),
    ),
  );
}

function connectCard(problem) {
  const reconnect = problem.kind === "reconnect";
  const embedded = window.parent !== window;
  return h(
    "div",
    { class: "cal-connect" },
    h("span", { class: "cal-connect-icon" }, icon("calendar", 22)),
    h("h2", {}, reconnect ? "Reconnect Google Calendar" : "Connect Google Calendar"),
    h(
      "p",
      {},
      reconnect
        ? "Google stopped accepting QM's access to your calendar. Sign in again to see your schedule."
        : "See your schedule here and answer invitations without leaving QM.",
    ),
    embedded
      ? h(
          "button",
          { class: "btn primary", type: "button", onclick: askHostToConnect },
          `${reconnect ? "Reconnect" : "Connect"} Google`,
        )
      : h("p", { class: "cal-connect-detail" }, "Open the Calendar tab in QM to connect Google."),
  );
}

function headerRow(days) {
  return h(
    "div",
    { class: "cal-head" },
    h("div", { class: "cal-gutter cal-zone" }, zoneLabel()),
    days.map((day) =>
      h(
        "div",
        {
          class: `cal-day-head ${isToday(day) ? "is-today" : ""} ${day < startOfDay(new Date()) ? "is-past" : ""}`,
          "aria-label": LONG_DATE.format(day),
        },
        h("span", { class: "cal-dow" }, WEEKDAY.format(day)),
        h("span", { class: "cal-date" }, String(day.getDate())),
      ),
    ),
  );
}

function bar(item) {
  const { event } = item;
  return h(
    "button",
    {
      type: "button",
      class: `${eventClass(event, item.end)} cal-bar ${item.clippedStart ? "clip-start" : ""} ${item.clippedEnd ? "clip-end" : ""}`,
      style: `--ev:${event.color};grid-column:${item.col + 1} / span ${item.span};grid-row:${item.lane + 1}`,
      "aria-label": `${titleOf(event)}, ${whenLabel(item)}`,
      onclick: onEventClick(event),
    },
    !event.allDay && h("span", { class: "cal-event-time" }, timeLabel(item.start)),
    h("span", { class: "cal-event-title" }, titleOf(event)),
  );
}

function allDayRow(bars) {
  const lanes = bars.reduce((most, item) => Math.max(most, item.lane + 1), 0);
  return h(
    "div",
    { class: "cal-allday" },
    h("div", { class: "cal-gutter cal-allday-label" }, "All day"),
    h("div", { class: "cal-allday-lanes", style: `--lanes:${Math.max(1, lanes)}` }, bars.map(bar)),
  );
}

function block(item) {
  const { event } = item;
  const height = ((item.bottom - item.top) / 60) * HOUR_PX;
  const compact = height < 38;
  const left = item.col / item.cols;
  const width =
    item.col + item.width < item.cols ? Math.min((item.width / item.cols) * 1.7, 1 - left) : item.width / item.cols;
  return h(
    "button",
    {
      type: "button",
      class: `${eventClass(event, item.end)} cal-block ${compact ? "is-compact" : ""}`,
      style: `--ev:${event.color};top:${(item.top / 60) * HOUR_PX}px;height:${Math.max(height - 2, 16)}px;left:calc(${left * 100}% + 1px);width:calc(${width * 100}% - 6px);z-index:${item.col + 1}`,
      "aria-label": `${titleOf(event)}, ${whenLabel(item)}`,
      onclick: onEventClick(event),
    },
    h("span", { class: "cal-event-title" }, titleOf(event)),
    h("span", { class: "cal-event-time" }, compact ? timeLabel(item.start) : timeRange(item.start, item.end)),
    !compact && event.location && height > 64 && h("span", { class: "cal-event-where" }, event.location),
  );
}

function grid() {
  const days = weekDays(state.anchor);
  const spans = (state.data?.events ?? []).map(eventSpan);
  const now = new Date();
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;
  const showNow = days.some(isToday);
  const hourLabel = (hour) =>
    hour && !(showNow && Math.abs(hour * HOUR_PX - nowTop) < HOUR_PX / 3)
      ? HOUR_ONLY.format(new Date(2000, 0, 1, hour))
      : "";
  return h(
    "div",
    { class: "cal-grid cal-week", style: `--days:7;--hour:${HOUR_PX}px` },
    state.loading && h("div", { class: "cal-progress", "aria-hidden": "true" }),
    h("div", { class: "cal-fixed" }, headerRow(days), allDayRow(laneBars(spans.filter(spansDays), days))),
    h(
      "div",
      { class: "cal-scroll" },
      h(
        "div",
        { class: "cal-body" },
        h(
          "div",
          { class: "cal-gutter cal-hours", "aria-hidden": "true" },
          Array.from({ length: 24 }, (_, hour) => h("span", { style: `top:${hour * HOUR_PX}px` }, hourLabel(hour))),
          showNow && h("span", { class: "cal-now-label", style: `top:${nowTop}px` }, timeLabel(now)),
        ),
        showNow && h("div", { class: "cal-now-line", style: `top:${nowTop - 0.5}px`, "aria-hidden": "true" }),
        days.map((day) =>
          h(
            "div",
            { class: `cal-col ${isToday(day) ? "is-today" : ""}`, role: "group", "aria-label": LONG_DATE.format(day) },
            dayBlocks(spans, day).map(block),
            isToday(day) && h("div", { class: "cal-now", style: `top:${nowTop}px`, "aria-hidden": "true" }),
          ),
        ),
      ),
    ),
  );
}

function descriptionText(raw) {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const p of doc.querySelectorAll("p, li")) p.append("\n");
  return doc.body.textContent.trim();
}

function statusMark(status) {
  if (status === "accepted") return h("span", { class: "cal-rsvp-mark is-yes", title: "Going" }, icon("check", 9));
  if (status === "declined") return h("span", { class: "cal-rsvp-mark is-no", title: "Not going" }, icon("x", 9));
  if (status === "tentative") return h("span", { class: "cal-rsvp-mark is-maybe", title: "Maybe" }, icon("help", 9));
  return null;
}

function initials(name) {
  return name
    .replaceAll("@", " ")
    .replaceAll(".", " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function guests(event) {
  if (!event.attendees.length) return null;
  const count = (status) => event.attendees.filter((person) => person.responseStatus === status).length;
  const summary = [
    count("accepted") && `${count("accepted")} yes`,
    count("declined") && `${count("declined")} no`,
    count("tentative") && `${count("tentative")} maybe`,
    count("needsAction") && `${count("needsAction")} awaiting`,
  ].filter(Boolean);
  return h(
    "div",
    { class: "cal-pop-row" },
    icon("users", 15),
    h(
      "div",
      { class: "cal-pop-guests" },
      h("div", {}, `${event.attendees.length} ${event.attendees.length === 1 ? "guest" : "guests"}`),
      h("div", { class: "cal-pop-muted" }, summary.join(", ")),
      h(
        "ul",
        {},
        event.attendees.map((person) =>
          h(
            "li",
            {},
            h(
              "span",
              { class: "cal-avatar", "aria-hidden": "true" },
              initials(person.name || person.email),
              statusMark(person.responseStatus),
            ),
            h(
              "span",
              { class: "cal-guest-name" },
              h("span", {}, `${person.name || person.email}${person.self ? " (you)" : ""}`),
              person.organizer && h("span", { class: "cal-pop-muted" }, "Organizer"),
            ),
          ),
        ),
      ),
    ),
  );
}

function popover(pop) {
  const { event } = pop;
  const calendar = state.data?.calendars.find((item) => item.id === event.calendarId);
  const locationUrl = event.location?.startsWith("https://") ? event.location : "";
  const external = { target: "_blank", rel: "noopener noreferrer" };
  const close = () => {
    state.popover = null;
    draw();
  };
  return h(
    "div",
    {
      class: "cal-pop",
      role: "dialog",
      "aria-label": titleOf(event),
      tabindex: "-1",
    },
    h(
      "div",
      { class: "cal-pop-actions" },
      event.htmlLink &&
        h(
          "a",
          {
            class: "icon-btn subtle",
            href: event.htmlLink,
            ...external,
            "aria-label": "Open in Google Calendar",
            title: "Open in Google Calendar",
          },
          icon("arrowUpRight", 15),
        ),
      h(
        "button",
        { class: "icon-btn subtle", type: "button", "aria-label": "Close", title: "Close", onclick: close },
        icon("x", 15),
      ),
    ),
    h(
      "div",
      { class: "cal-pop-head", style: `--ev:${event.color}` },
      h("span", { class: "cal-swatch" }),
      h(
        "div",
        {},
        h("h2", { class: event.selfResponse === "declined" ? "is-declined" : "" }, titleOf(event)),
        h("div", { class: "cal-pop-muted" }, whenLabel(eventSpan(event))),
      ),
    ),
    event.meetUrl &&
      h(
        "a",
        { class: "btn primary cal-meet", href: event.meetUrl, ...external },
        icon("video", 14),
        h("span", {}, "Join with Google Meet"),
      ),
    event.location &&
      h(
        "div",
        { class: "cal-pop-row" },
        icon("mapPin", 15),
        locationUrl ? h("a", { href: locationUrl, ...external }, event.location) : h("span", {}, event.location),
      ),
    guests(event),
    event.description &&
      h(
        "div",
        { class: "cal-pop-row" },
        icon("text", 15),
        h("div", { class: "cal-pop-text" }, descriptionText(event.description)),
      ),
    calendar && h("div", { class: "cal-pop-row" }, icon("calendar", 15), h("span", {}, calendar.name)),
    pop.error && h("div", { class: "cal-pop-error", role: "alert" }, pop.error),
    event.selfResponse &&
      h(
        "div",
        { class: "cal-pop-foot" },
        h("span", {}, "Going?"),
        h(
          "div",
          { class: "cron-segments cal-rsvp", role: "radiogroup", "aria-label": "Your response" },
          REPLIES.map(([status, label]) =>
            h(
              "button",
              {
                type: "button",
                role: "radio",
                "aria-checked": String(event.selfResponse === status),
                class: event.selfResponse === status ? "active" : "",
                disabled: pop.busy,
                onclick: () => void respond(status),
              },
              label,
            ),
          ),
        ),
      ),
  );
}

function placePopover() {
  const pop = document.querySelector(".cal-pop");
  if (!pop || !state.popover) return;
  const { rect } = state.popover;
  const gap = 8;
  const right = rect.right + gap;
  const left = right + pop.offsetWidth <= innerWidth - gap ? right : Math.max(gap, rect.left - gap - pop.offsetWidth);
  const top = Math.min(Math.max(gap, rect.top), Math.max(gap, innerHeight - pop.offsetHeight - gap));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function page() {
  const problem = state.problem;
  if (problem && problem.kind !== "error")
    return [h("div", { class: "pane-head" }, h("h1", { class: "pane-title" }, "Calendar")), connectCard(problem)];
  return [
    toolbar(),
    h(
      "section",
      { class: "cal-main", "aria-busy": String(state.loading) },
      problem &&
        h(
          "div",
          { class: "inbox-notice cal-notice", role: "alert" },
          h("span", {}, problem.message),
          h("button", { class: "btn", type: "button", onclick: () => void load() }, "Retry"),
        ),
      grid(),
    ),
    state.popover && popover(state.popover),
  ];
}

function draw() {
  const scrollTop = document.querySelector(".cal-scroll")?.scrollTop;
  const main = h("main", { class: "pane calendar-page" }, page());
  document.body.replaceChildren(main);
  const scroller = main.querySelector(".cal-scroll");
  if (scroller) scroller.scrollTop = scrollTop ?? MORNING_HOUR * HOUR_PX - HOUR_PX / 3;
  placePopover();
}

document.addEventListener("pointerdown", (e) => {
  if (state.popover && !e.target.closest?.(".cal-pop, .cal-event")) {
    state.popover = null;
    draw();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.popover) {
    state.popover = null;
    draw();
  }
});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void load());
setInterval(draw, 60_000);
void load();
