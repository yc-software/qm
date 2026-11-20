import assert from "node:assert/strict";
import { test } from "node:test";
import { googleCalendarEvents } from "../src/api/routes/connectors.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

function call(method: string, path: string, fetchImpl: typeof fetch, body?: unknown, params = {}) {
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
  return googleCalendarEvents(ctx)
    .finally(() => {
      globalThis.fetch = originalFetch;
    })
    .then(() => out);
}

const work = {
  id: "work@example.com",
  summary: "Work",
  backgroundColor: "#111111",
  accessRole: "owner",
  selected: true,
};

async function google(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/colors")) return Response.json({ event: { "5": { background: "#fbd75b" } } });
  if (url.pathname.endsWith("/users/me/calendarList"))
    return Response.json({ items: [work, { id: "hidden", accessRole: "reader", selected: false }] });
  if (url.pathname.includes("/users/me/calendarList/")) return Response.json(work);
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
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
  const calendars = [{ id: "work@example.com", name: "Work", color: "#111111", primary: false, writable: true }];
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
        editable: true,
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
        editable: false,
      },
    ],
  });
  const events = out.requests.find((r) => r.url.pathname.endsWith("/events"));
  assert.equal(events?.url.pathname, "/calendar/v3/calendars/work%40example.com/events");
  assert.equal(events?.url.searchParams.get("singleEvents"), "true");
});

test("creates, RSVPs and deletes events with the Google write semantics", async () => {
  const created = await call("POST", "/v1/connectors/google-calendar/events", google, {
    title: "Lunch",
    start: "2026-11-22",
    end: "2026-11-23",
    allDay: true,
    attendees: ["x@example.com"],
    addMeet: true,
  });
  assert.equal(created.status, 200);
  const insert = created.requests.find((r) => r.method === "POST")!;
  assert.equal(insert.url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(insert.url.searchParams.get("conferenceDataVersion"), "1");
  const insertBody = insert.body as Record<string, any>;
  assert.deepEqual(insertBody.start, { date: "2026-11-22" });
  assert.deepEqual(insertBody.attendees, [{ email: "x@example.com" }]);
  assert.equal(insertBody.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");

  const params = { calendarId: "work@example.com", eventId: "e1" };
  const rsvp = await call(
    "PATCH",
    "/v1/connectors/google-calendar/events/x/e1",
    google,
    { responseStatus: "accepted" },
    params,
  );
  assert.equal(rsvp.status, 200);
  assert.deepEqual(rsvp.requests.find((r) => r.method === "PATCH")?.body, {
    attendees: [{ email: "eve@example.com", self: true, responseStatus: "accepted" }, { email: "x@example.com" }],
  });

  const deleted = await call("DELETE", "/v1/connectors/google-calendar/events/x/e1", google, undefined, params);
  assert.equal(deleted.status, 204);

  for (const bad of [
    { title: "x", start: "2026-11-22T10:00:00Z", end: "nope", allDay: false },
    { title: "x", start: "2026-11-22T10:00:00Z", end: "2026-11-22T11:00:00Z", allDay: true },
  ]) {
    const out = await call("POST", "/v1/connectors/google-calendar/events", google, bad);
    assert.equal(out.status, 400);
    assert.equal(out.requests.length, 0);
  }
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
