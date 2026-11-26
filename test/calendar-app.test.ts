import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

interface Span {
  event: { id: string };
  start: Date;
  end: Date;
}
const app = (path: string): Promise<Record<string, (...args: never[]) => unknown>> =>
  import(new URL(`../apps-seed/calendar/${path}`, import.meta.url).href);
const { dayBlocks, eventSpan, laneBars, weekDays } = (await app("public/layout.js")) as unknown as {
  weekDays: (anchor: Date) => Date[];
  eventSpan: (event: unknown) => Span;
  dayBlocks: (spans: Span[], day: Date) => Array<Span & { top: number; col: number; cols: number; width: number }>;
  laneBars: (
    spans: Span[],
    days: Date[],
  ) => Array<Span & { col: number; span: number; lane: number; clippedStart: boolean }>;
};
const { brokerClient, listEvents, respond } = (await app("google.mjs")) as unknown as {
  brokerClient: (opts: { apiUrl: string; token: string; fetchImpl: typeof fetch }) => unknown;
  listEvents: (
    google: unknown,
    timeMin: string,
    timeMax: string,
  ) => Promise<{ events: Array<Record<string, unknown>> }>;
  respond: (google: unknown, calendarId: string, eventId: string, status: string) => Promise<Record<string, unknown>>;
};
const { viewerOf } = (await app("server.mjs")) as unknown as {
  viewerOf: (header: unknown, key: string, now?: number) => string | null;
};

const event = (id: string, start: string, end: string, allDay = false) => ({ id, title: id, start, end, allDay });

test("a week starts on the week's first day", () => {
  const week = weekDays(new Date(2026, 10, 20));
  assert.deepEqual([week.length, week[0]!.getDate(), week[6]!.getDate()], [7, 15, 21]);
});

test("overlapping events share a day side by side and multi-day events take clipped lanes", () => {
  const day = new Date(2026, 10, 20);
  const blocks = dayBlocks(
    [
      event("a", "2026-11-20T10:00:00", "2026-11-20T11:00:00"),
      event("b", "2026-11-20T10:30:00", "2026-11-20T11:30:00"),
      event("c", "2026-11-20T13:00:00", "2026-11-20T14:00:00"),
      event("all", "2026-11-20", "2026-11-21", true),
    ].map(eventSpan),
    day,
  );
  assert.deepEqual(
    blocks.map((b) => [b.event.id, b.top, b.col, b.cols, b.width]),
    [
      ["a", 600, 0, 2, 1],
      ["b", 630, 1, 2, 1],
      ["c", 780, 0, 1, 1],
    ],
  );
  const bars = laneBars(
    [event("trip", "2026-11-13", "2026-11-17", true), event("offsite", "2026-11-16", "2026-11-19", true)].map(
      eventSpan,
    ),
    weekDays(day),
  );
  assert.deepEqual(
    bars.map((b) => [b.event.id, b.col, b.span, b.lane, b.clippedStart]),
    [
      ["trip", 0, 2, 0, true],
      ["offsite", 1, 3, 1, false],
    ],
  );
});

function fakeBroker(google: (method: string, url: URL, body?: unknown) => { status: number; body?: unknown }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = (async (_url: URL, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { connector: string; method: string; url: string; body?: string };
    assert.equal(req.connector, "www.googleapis.com");
    const url = new URL(req.url);
    const body = req.body ? JSON.parse(req.body) : undefined;
    calls.push({ method: req.method, path: url.pathname, ...(body ? { body } : {}) });
    const r = google(req.method, url, body);
    return Response.json({ status: r.status, body: JSON.stringify(r.body ?? {}) });
  }) as typeof fetch;
  return { google: brokerClient({ apiUrl: "https://qm.example.com", token: "t", fetchImpl }), calls };
}

test("the app lists selected calendars' events and RSVPs through the publisher's Google connection", async () => {
  const meeting = {
    id: "e1",
    summary: "Standup",
    start: { dateTime: "2026-11-20T10:00:00Z" },
    end: { dateTime: "2026-11-20T10:15:00Z" },
    attendees: [{ email: "ada@example.com", self: true, responseStatus: "needsAction" }],
  };
  const { google, calls } = fakeBroker((method, url, body) => {
    if (url.pathname.endsWith("/calendarList"))
      return { status: 200, body: { items: [{ id: "primary", summary: "Ada", selected: true }, { id: "hidden" }] } };
    if (url.pathname.endsWith("/calendarList/primary")) return { status: 200, body: { id: "primary" } };
    if (url.pathname.endsWith("/colors")) return { status: 200, body: { event: {} } };
    if (method === "PATCH") return { status: 200, body: { ...meeting, ...(body as object) } };
    if (url.searchParams.get("pageToken")) return { status: 200, body: { items: [] } };
    if (url.pathname.endsWith("/events")) return { status: 200, body: { items: [meeting], nextPageToken: "p2" } };
    return { status: 200, body: meeting };
  });
  const listed = await listEvents(google, "2026-11-15T00:00:00Z", "2026-11-22T00:00:00Z");
  assert.deepEqual(
    listed.events.map((e) => [e.id, e.calendarId, e.selfResponse]),
    [["e1", "primary", "needsAction"]],
  );
  assert.equal(calls.filter((c) => c.path.endsWith("/primary/events")).length, 2);
  const replied = await respond(google, "primary", "e1", "accepted");
  assert.equal(replied.selfResponse, "accepted");
  assert.deepEqual(calls.at(-1), {
    method: "PATCH",
    path: "/calendar/v3/calendars/primary/events/e1",
    body: { attendees: [{ email: "ada@example.com", self: true, responseStatus: "accepted" }] },
  });
});

test("a missing loan asks to connect and a revoked grant asks to reconnect", async () => {
  const revoked = fakeBroker(() => ({ status: 401 })).google;
  await assert.rejects(listEvents(revoked, "2026-11-15", "2026-11-22"), { status: 409, extra: { reconnect: true } });
  const fetchImpl = (async () =>
    Response.json({ error: "connector_unavailable" }, { status: 409 })) as unknown as typeof fetch;
  const unlent = brokerClient({ apiUrl: "https://qm.example.com", token: "t", fetchImpl });
  await assert.rejects(listEvents(unlent, "2026-11-15", "2026-11-22"), { status: 409, code: "not_connected" });
});

test("only a portal identity signed for this app and unexpired names the viewer", () => {
  const key = "k".repeat(32);
  const sign = (claims: object, secret = key) => {
    const head = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
  };
  assert.equal(viewerOf(sign({ p: "Ada@Example.com", exp: 2_000 }), key, 1_000), "ada@example.com");
  assert.equal(viewerOf(sign({ p: "ada@example.com", exp: 2_000 }), key, 3_000), null);
  assert.equal(viewerOf(sign({ p: "ada@example.com", exp: 2_000 }, "x".repeat(32)), key, 1_000), null);
});
