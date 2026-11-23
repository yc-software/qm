import assert from "node:assert/strict";
import { test } from "node:test";
import { googleCalendarEvents, googleCalendarRsvp } from "../src/api/routes/connectors.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

function call(method: string, path: string, fetchImpl: typeof fetch, body?: unknown, params = {}) {
  const handle = method === "GET" ? googleCalendarEvents : googleCalendarRsvp;
  const out = { status: 0, body: undefined as unknown, requests: [] as { method: string; url: URL; body: unknown }[] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    out.requests.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return fetchImpl(input, init);
  };
  const ctx = {
    req: { method },
    actor: { p: "eve@example.com" },
    url: new URL(`http://localhost${path}`),
    params,
    body,
    res: {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        out.status = code;
      },
      end(value?: string) {
        out.body = value ? JSON.parse(value) : undefined;
      },
    },
    deps: { connectorTokens: { connectorDerivedAuth: async () => ({ accessToken: "token" }) } },
  } as unknown as ApiCtx;
  return handle(ctx)
    .finally(() => {
      globalThis.fetch = originalFetch;
    })
    .then(() => out);
}

const work = {
  id: "work@example.com",
  summary: "Work",
  backgroundColor: "#111111",
  selected: true,
};

async function google(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/colors")) return Response.json({ event: { "5": { background: "#fbd75b" } } });
  if (url.pathname.endsWith("/users/me/calendarList"))
    return Response.json({ items: [work, { id: "hidden", selected: false }] });
  if (url.pathname.includes("/users/me/calendarList/")) return Response.json(work);
  if (url.pathname.endsWith("/events") && init?.method === "GET")
    return Response.json({
      items: [
        {
          id: "b",
          summary: "Standup",
          start: { dateTime: "2026-11-20T10:00:00-08:00" },
          end: { dateTime: "2026-11-20T10:15:00-08:00" },
          hangoutLink: "https://meet.example/abc",
          colorId: "5",
          organizer: { email: "boss@example.com" },
          attendees: [
            { email: "eve@example.com", self: true },
            { email: "boss@example.com", organizer: true },
          ],
        },
        {
          id: "a",
          summary: "Offsite",
          start: { date: "2026-11-20" },
          end: { date: "2026-11-21" },
          organizer: { self: true },
        },
      ],
    });
  if (url.pathname.endsWith("/events/e1") && init?.method === "GET")
    return Response.json({
      id: "e1",
      attendees: [{ email: "eve@example.com", self: true }, { email: "x@example.com" }],
    });
  return Response.json({
    id: "e1",
    start: { date: "2026-11-22" },
    end: { date: "2026-11-23" },
    organizer: { self: true },
  });
}

test("lists selected calendars and their events in start order", async () => {
  const out = await call(
    "GET",
    "/v1/connectors/google-calendar/events?timeMin=2026-11-16T00:00:00Z&timeMax=2026-11-23T00:00:00Z",
    google,
  );
  assert.equal(out.status, 200);
  const calendars = [{ id: "work@example.com", name: "Work", color: "#111111" }];
  assert.deepEqual(out.body, {
    accountType: "default",
    calendars,
    events: [
      {
        id: "a",
        calendarId: "work@example.com",
        title: "Offsite",
        start: "2026-11-20",
        end: "2026-11-21",
        allDay: true,
        htmlLink: "",
        color: "#111111",
        attendees: [],
      },
      {
        id: "b",
        calendarId: "work@example.com",
        title: "Standup",
        start: "2026-11-20T10:00:00-08:00",
        end: "2026-11-20T10:15:00-08:00",
        allDay: false,
        meetUrl: "https://meet.example/abc",
        htmlLink: "",
        color: "#fbd75b",
        attendees: [
          { email: "eve@example.com", responseStatus: "needsAction", self: true, organizer: false },
          { email: "boss@example.com", responseStatus: "needsAction", self: false, organizer: true },
        ],
        selfResponse: "needsAction",
      },
    ],
  });
  const events = out.requests.find((r) => r.url.pathname.endsWith("/events"));
  assert.equal(events?.url.pathname, "/calendar/v3/calendars/work%40example.com/events");
  assert.equal(events?.url.searchParams.get("singleEvents"), "true");
});

test("RSVPs by patching only the person's own attendee status", async () => {
  const params = { calendarId: "work@example.com", eventId: "e1" };
  const path = "/v1/connectors/google-calendar/events/x/e1";
  const rsvp = await call("PATCH", path, google, { responseStatus: "accepted" }, params);
  assert.equal(rsvp.status, 200);
  const patch = rsvp.requests.find((r) => r.method === "PATCH")!;
  assert.equal(patch.url.searchParams.get("sendUpdates"), "all");
  assert.deepEqual(patch.body, {
    attendees: [{ email: "eve@example.com", self: true, responseStatus: "accepted" }, { email: "x@example.com" }],
  });
  const bad = await call("PATCH", path, google, { responseStatus: "needsAction" }, params);
  assert.equal(bad.status, 400);
  assert.equal(bad.requests.length, 0);
});

test("upstream auth failures ask the person to reconnect", async () => {
  const out = await call(
    "GET",
    "/v1/connectors/google-calendar/events?timeMin=2026-11-16T00:00:00Z&timeMax=2026-11-23T00:00:00Z",
    async () => new Response("detail", { status: 403 }),
  );
  assert.equal(out.status, 409);
  assert.deepEqual(out.body, {
    error: "calendar_unavailable",
    reconnect: true,
    message: "Reconnect Google to use your calendar.",
  });
});
