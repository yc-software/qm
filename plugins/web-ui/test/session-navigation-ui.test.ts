import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSessionNavigation,
  projectSessionPage,
  resolveSessionReferences,
} from "../../../src/api/session-navigation.ts";
import type { Session } from "../../../src/types.ts";
import type { ContextSummary } from "../../../src/api/app-types.ts";
import type { CoreContext, CoreSession } from "../src/core-bridge.ts";
import { harness } from "./deep-link-boot-fixture.ts";

function session(id: string, fields: Partial<CoreSession> = {}): CoreSession {
  return {
    id,
    type: "dm",
    threadRef: `web:tester:${id}`,
    scopeId: "personal:tester",
    createdAt: 1,
    lastActivityAt: 100,
    title: id,
    ...fields,
  };
}
function model() {
  const rows = [
    ...Array.from({ length: 65 }, (_, i) => session(`pin-${String(i).padStart(3, "0")}`, { pinned: true })),
    ...Array.from({ length: 65 }, (_, i) => session(`recent-${String(i).padStart(3, "0")}`)),
    ...Array.from({ length: 65 }, (_, i) => session(`archive-${String(i).padStart(3, "0")}`, { archived: true })),
    ...Array.from({ length: 55 }, (_, i) =>
      session(`group-${String(i).padStart(3, "0")}`, { scopeId: `channel:g${i}`, channelName: `Group ${i}` }),
    ),
    session("waiting", { awaitingInput: true }),
    session("child", { parentSessionId: "recent-000", awaitingInput: true }),
  ];
  const contexts: CoreContext[] = [
    { scopeId: "personal:tester", kind: "personal", name: "Personal", sessionCount: 197, lastActivityAt: 100 },
    ...Array.from({ length: 55 }, (_, i): CoreContext => ({
      scopeId: `channel:g${i}`,
      kind: "channel",
      name: `Group ${i}`,
      sessionCount: 1,
      lastActivityAt: 100,
    })),
  ];
  const requests: { path: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  let intercept:
    ((path: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined) | undefined;
  const onRequest = async (path: string, init?: RequestInit): Promise<Response | undefined> => {
    const overridden = await intercept?.(path, init);
    if (overridden) return overridden;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.startsWith("/api/session-navigation")) requests.push({ path, body, signal: init?.signal });
    const coreRows = rows as unknown as Session[];
    const coreContexts = contexts as unknown as ContextSummary[];
    if (path === "/api/session-navigation")
      return Response.json(projectSessionNavigation(coreRows, coreRows, coreContexts, "tester", body));
    if (path === "/api/session-navigation/page") return Response.json(projectSessionPage(coreRows, coreContexts, body));
    if (path === "/api/session-navigation/resolve")
      return Response.json(resolveSessionReferences(coreRows, body.references));
    if (path.startsWith("/api/sessions/") && init?.method === "POST") {
      const row = rows.find((row) => path === `/api/sessions/${row.id}`)!;
      Object.assign(row, body);
      return Response.json({ session: row });
    }
    return undefined;
  };
  return {
    rows,
    contexts,
    requests,
    onRequest,
    intercept: (value: typeof intercept) => {
      intercept = value;
    },
  };
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `UI condition did not settle: ${document.querySelector(".main")?.textContent?.slice(0, 2000)}`);
}
function click(selector: string): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, selector);
  button.click();
}

test("thread-only restore resolves an off-page session while selected-context paging includes children", async () => {
  const m = model();
  const target = m.rows.find((row) => row.id === "recent-064")!;
  const h = await harness({
    path: "/",
    welcome: true,
    listSessions: m.rows,
    contexts: m.contexts,
    onRequest: m.onRequest,
    entries: [{ seq: 1, type: "user", createdAt: 1, payload: { text: "Restored off-page content" } }],
    remoteCanvas: {
      v: 1,
      active: true,
      root: { kind: "split", a: { kind: "leaf", threadRef: target.threadRef }, b: { kind: "leaf" } },
    },
  });
  try {
    await h.boot();
    await until(() => h.mainText().includes("Restored off-page content"));
    assert.ok(
      m.requests.some(
        (request) => request.path.endsWith("/resolve") && JSON.stringify(request.body).includes(target.threadRef),
      ),
    );
    assert.equal(h.requests.includes("/api/sessions"), false);
    h.switchView("contexts");
    await until(() => document.querySelectorAll(".context-row").length > 0);
    const personal = [...document.querySelectorAll<HTMLButtonElement>(".context-row")].find((row) =>
      row.textContent?.includes("Personal"),
    );
    assert.ok(personal);
    personal.click();
    await until(
      () =>
        document.querySelector('.context-detail[data-session-page-state="ready"]') !== null &&
        document.querySelectorAll(".context-session-row").length === 50,
    );
    assert.equal(document.querySelector(".context-panel-count")?.textContent, "132");
    while (document.querySelector('[data-session-page="context"].btn')) {
      const before = document.querySelectorAll(".context-session-row").length;
      click('[data-session-page="context"].btn');
      await until(() => document.querySelectorAll(".context-session-row").length > before);
    }
    assert.equal(document.querySelectorAll(".context-session-row").length, 132);
    assert.match(h.mainText(), /child/);
    const beforeFocus = m.requests.length;
    window.dispatchEvent(new Event("focus"));
    assert.equal(document.querySelectorAll(".context-session-row").length, 132);
    await until(
      () =>
        m.requests.length >= beforeFocus + 3 &&
        document.querySelector('.context-detail[data-session-page-state="ready"]') !== null,
    );
    assert.equal(document.querySelectorAll(".context-session-row").length, 132);
    assert.equal(m.requests.slice(beforeFocus).filter((request) => request.path.endsWith("/page")).length, 3);
  } finally {
    await h.close();
  }
});

test("bounded navigation pages all sections and retains exact totals without fetching legacy history or contexts", async () => {
  const m = model();
  const h = await harness({
    path: "/",
    welcome: true,
    listSessions: m.rows,
    contexts: m.contexts,
    onRequest: m.onRequest,
  });
  try {
    await h.boot();
    assert.equal(h.requests.includes("/api/sessions"), false);
    assert.equal(h.requests.includes("/api/contexts"), false);
    assert.equal(document.querySelectorAll(".pinned-children [data-session-id]").length, 50);
    assert.equal(document.querySelectorAll(".recent-project").length, 50);
    assert.match(document.querySelector(".archived-count")?.textContent ?? "", /^65$/);
    assert.ok(h.sessionsState.list.length < m.rows.length);
    click('[data-session-page="pinned"]');
    await until(() => document.querySelectorAll(".pinned-children [data-session-id]").length === 65);
    click('[data-session-page="groups"]');
    await until(() => document.querySelectorAll(".recent-project").length === 56);
    const personalMore = '[data-session-page="group"][data-scope-id="personal:tester"]';
    click(personalMore);
    await until(() => document.querySelectorAll('[data-session-id^="recent-"]').length === 50);
    click(personalMore);
    await until(() => document.querySelectorAll('[data-session-id^="recent-"]').length === 65);
    const recent = () => document.querySelector<HTMLButtonElement>('[data-session-page="recent"]');
    while (recent()) {
      const previous = m.requests.length;
      recent()!.click();
      await until(() => m.requests.length > previous && !recent()?.disabled);
    }
    assert.ok(document.querySelector('[data-session-id="recent-064"]'));
    click(".archived-toggle:not([data-session-page])");
    await until(() => document.querySelectorAll(".archived-children [data-session-id]").length === 50);
    click('[data-session-page="archived"]');
    await until(() => document.querySelectorAll(".archived-children [data-session-id]").length === 65);
    assert.equal(h.requests.includes("/api/sessions"), false);
    assert.ok(m.requests.every((request) => request.body.principalId === undefined));
    let complete!: (response: Response) => void;
    m.intercept((path, init) => {
      if (path === "/api/session-navigation" && JSON.parse(String(init?.body)).cursor && !complete)
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      return undefined;
    });
    const failedRefresh = h.refreshSessions();
    await until(() => Boolean(complete));
    assert.equal(document.querySelectorAll(".pinned-children [data-session-id]").length, 65);
    assert.equal(document.querySelectorAll(".recent-project").length, 56);
    assert.equal(document.querySelectorAll(".archived-children [data-session-id]").length, 65);
    complete(Response.json({ error: "modeled refresh failure" }, { status: 500 }));
    assert.equal(await failedRefresh, false);
    assert.equal(document.querySelectorAll(".pinned-children [data-session-id]").length, 65);
    m.intercept(undefined);
    m.rows.push(
      ...Array.from({ length: 200 }, (_, i) => session(`new-pin-${i}`, { pinned: true, lastActivityAt: 101 })),
    );
    const beforeRefresh = m.requests.length;
    assert.equal(await h.refreshSessions(), true);
    assert.equal(document.querySelectorAll(".pinned-children [data-session-id]").length, 100);
    assert.equal(document.querySelector("[data-session-navigation]")?.getAttribute("data-session-pinned-total"), "265");
    assert.equal(document.querySelectorAll(".recent-project").length, 56);
    assert.equal(document.querySelectorAll(".archived-children [data-session-id]").length, 65);
    assert.equal(document.querySelectorAll('[data-session-id^="recent-"]').length, 65);
    const refreshed = m.requests.slice(beforeRefresh);
    assert.equal(refreshed.length, 8);
    assert.equal(refreshed.filter((request) => request.path.endsWith("/page")).length, 2);
  } finally {
    await h.close();
  }
});

test("Chats searches off-page titles with exact status totals and discards canceled filter responses", async () => {
  const m = model();
  m.rows.find((row) => row.id === "recent-064")!.title = "Needle Ω";
  const h = await harness({
    path: "/settings",
    welcome: true,
    listSessions: m.rows,
    contexts: m.contexts,
    onRequest: m.onRequest,
  });
  try {
    await h.boot();
    await h.sessionsReady();
    h.appState.currentView = "chats";
    h.drawChatsPage();
    await until(() => document.querySelector('.chats-page[data-session-page-state="ready"]') !== null);
    assert.equal(document.querySelectorAll(".chat-row").length, 50);
    click('button[data-session-page="chats"]');
    await until(() => document.querySelectorAll(".chat-row").length === 100);
    const beforeRefresh = m.requests.length;
    await h.refreshSessions();
    await until(() => document.querySelector('.chats-page[data-session-page-state="ready"]') !== null);
    assert.equal(document.querySelectorAll(".chat-row").length, 100);
    assert.equal(m.requests.slice(beforeRefresh).filter((request) => request.path.endsWith("/page")).length, 2);
    assert.match(
      document.querySelector('[role="tablist"]')?.textContent ?? "",
      /Active\s*185.*Waiting\s*1.*Archived\s*65/s,
    );
    let complete!: (response: Response) => void;
    let oldSignal: AbortSignal | null | undefined;
    m.intercept((path, init) => {
      if (path === "/api/session-navigation/page" && JSON.parse(String(init?.body)).query === "old") {
        oldSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }
      return undefined;
    });
    const query = document.querySelector<HTMLInputElement>('input[placeholder="Search chats…"]')!;
    query.value = "old";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => Boolean(complete));
    query.value = "needle Ω";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    await until(
      () =>
        document.querySelectorAll(".chat-row").length === 1 &&
        document.querySelector(".chat-row")!.textContent!.includes("Needle Ω"),
    );
    assert.equal(oldSignal?.aborted, true);
    complete(Response.json({ error: "late failure" }, { status: 500 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(document.querySelector('.chats-page[data-session-page-state="ready"]') !== null, true);
    assert.match(h.mainText(), /Needle Ω/);
    assert.doesNotMatch(h.mainText(), /late failure/);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});

test("successful pin changes refresh page membership and totals while retaining an open off-page entity", async () => {
  const m = model();
  const target = m.rows.find((row) => row.id === "recent-064")!;
  const h = await harness({
    path: `/s/${target.id}`,
    session: target,
    welcome: true,
    listSessions: m.rows,
    contexts: m.contexts,
    onRequest: m.onRequest,
  });
  try {
    await h.boot();
    await until(() => Boolean(document.querySelector('[data-session-id="pin-000"]')));
    click('[data-menu-id="pin-000"]');
    const unpin = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) =>
      button.textContent?.includes("Unpin"),
    );
    assert.ok(unpin);
    unpin.click();
    await until(
      () =>
        !m.rows.find((row) => row.id === "pin-000")!.pinned &&
        m.requests.filter((request) => request.path === "/api/session-navigation").length >= 2,
    );
    await until(() => !document.querySelector('.pinned-children [data-session-id="pin-000"]'));
    assert.equal(
      h.sessionsState.list.some((row) => row.id === target.id),
      true,
    );
    assert.equal(h.visibleConversation().state.sessionId, target.id);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});

test("navigation compatibility accepts only exact route absence and refuses malformed successes or denied reads", async () => {
  const m = model();
  let supplied: Response | undefined;
  m.intercept(() => supplied);
  const h = await harness({ path: "/settings", onRequest: m.onRequest });
  try {
    const transport = h.navigationTransport;
    const good = projectSessionNavigation(
      m.rows as unknown as Session[],
      m.rows as unknown as Session[],
      m.contexts as unknown as ContextSummary[],
      "tester",
      {},
    );
    for (const bad of [
      null,
      {},
      { ...good, recent: { ...good.recent, items: Array(51).fill(good.recent.items[0]) } },
      { ...good, statusTotals: { active: -1, waiting: 0, archived: 0 } },
      { ...good, startup: {} },
      { ...good, groups: { ...good.groups, items: [{ ...good.groups.items[0], sessions: [] }] } },
    ]) {
      supplied = Response.json(bad);
      await assert.rejects(transport.fetchNavigation({}), /Invalid session navigation/);
    }
    for (const status of [401, 403, 500, 404]) {
      supplied = Response.json({ error: "denied" }, { status });
      await assert.rejects(transport.fetchNavigation({}));
    }
    assert.equal(h.requests.includes("/api/sessions"), false);
    supplied = Response.json({ error: "not found" }, { status: 404 });
    assert.equal(await transport.fetchNavigation({}), null);
    const count = h.requests.length;
    assert.equal(await transport.fetchSessionPage({}), null);
    assert.equal(h.requests.length, count);
    transport.resetNavigationTransport();
    supplied = Response.json({ error: "not_found", message: "POST /v1/session-navigation/resolve" }, { status: 404 });
    assert.equal(await transport.fetchSessionReferences([]), null);
    transport.resetNavigationTransport();
    supplied = Response.json(good);
    assert.deepEqual(await transport.fetchNavigation({}), good);
    const aborted = new AbortController();
    aborted.abort();
    const before = h.requests.length;
    await assert.rejects(transport.fetchNavigation({}, aborted.signal), /abort/i);
    assert.equal(h.requests.length, before);
    supplied = Response.json({ references: [] });
    await assert.rejects(
      transport.fetchSessionReferences([{ kind: "id", value: "missing" }]),
      /Invalid session navigation/,
    );
  } finally {
    await h.close();
  }
});

test("simultaneous exact references coalesce into bounded batches and retain authoritative missing results", async () => {
  const m = model();
  const h = await harness({ path: "/settings", onRequest: m.onRequest });
  try {
    const refs = m.rows.slice(0, 14).map((row) => ({ kind: "id" as const, value: row.id }));
    const result = await Promise.all([...refs, refs[0]!].map((ref) => h.resolveSessionReference(ref)));
    assert.deepEqual(
      result.map((row) => row?.id),
      [...refs, refs[0]!].map((ref) => ref.value),
    );
    const requests = m.requests.filter((request) => request.path.endsWith("/resolve"));
    assert.deepEqual(
      requests.map((request) => (request.body.references as unknown[]).length),
      [12, 2],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    m.rows.splice(0, 1);
    assert.equal(await h.resolveSessionReference(refs[0]!), null);
    assert.equal(
      h.sessionsState.list.some((row) => row.id === refs[0]!.value),
      false,
    );
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});

for (const phase of ["queued", "in flight", "fulfilled"] as const) {
  test(`reset discards ${phase} reference promises before a new actor resolves the same reference`, async () => {
    const m = model();
    const ref = { kind: "id" as const, value: m.rows[0]!.id };
    let release: ((response: Response) => void) | undefined;
    let calls = 0;
    const response = () => Response.json(resolveSessionReferences(m.rows as unknown as Session[], [ref]));
    const h = await harness({
      path: "/settings",
      onRequest: (path) => {
        if (path !== "/api/session-navigation/resolve") return;
        calls++;
        if (phase === "in flight" && calls === 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return response();
      },
    });
    let first: Promise<CoreSession | null> | undefined;
    let second: Promise<CoreSession | null> | undefined;
    try {
      first = h.resolveSessionReference(ref);
      void first.catch(() => undefined);
      if (phase === "in flight") await until(() => Boolean(release));
      if (phase === "fulfilled") await first;
      h.resetSessions();
      second = h.resolveSessionReference(ref);
      void second.catch(() => undefined);
      assert.notEqual(first, second);
      if (release) {
        await until(() => calls === 2);
        release(response());
      }
      const [old, fresh] = await Promise.allSettled([first, second]);
      assert.equal(old.status, phase === "fulfilled" ? "fulfilled" : "rejected");
      if (old.status === "rejected") assert.equal((old.reason as Error).name, "AbortError");
      assert.equal(fresh.status, "fulfilled");
      if (fresh.status === "fulfilled") assert.equal(fresh.value?.id, ref.value);
      assert.equal(calls, phase === "queued" ? 1 : 2);
    } finally {
      release?.(response());
      await Promise.allSettled([first, second]);
      await h.close();
    }
  });
}

for (const status of [200, 403]) {
  for (const leave of [false, true]) {
    test(`scoped backlink ${status} respects ${leave ? "a newer Settings view" : "its current Files owner"}`, async () => {
      const m = model();
      const row = m.rows[0]!;
      let hold = false;
      let release: ((response: Response) => void) | undefined;
      let response: Response;
      m.intercept((path, init) => {
        if (path !== "/api/session-navigation/resolve" || !hold) return;
        response =
          status === 200
            ? Response.json(
                resolveSessionReferences(m.rows as unknown as Session[], JSON.parse(String(init?.body)).references),
              )
            : Response.json({ error: "denied" }, { status });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      const h = await harness({ path: `/s/${row.id}`, session: row, listSessions: m.rows, onRequest: m.onRequest });
      try {
        await h.boot();
        click('.session-tool[aria-label="Files"]');
        await until(() => Boolean(document.querySelector(".session-heading.as-link")));
        hold = true;
        click(".session-heading.as-link");
        await until(() => Boolean(release));
        if (leave) h.switchView("settings");
        release!(response!);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const expectedView = status === 200 ? "chats" : "files";
        assert.equal(h.appState.currentView, leave ? "settings" : expectedView);
        if (leave) assert.equal(document.querySelector(".session-heading.as-link"), null);
        else if (status === 200) assert.equal(h.visibleConversation().state.sessionId, row.id);
        else assert.match(document.querySelector(".session-heading.as-link")?.textContent ?? "", /pin-000/);
      } finally {
        if (release) release(response!);
        await h.close();
      }
    });
  }
}

for (const status of [200, 403]) {
  for (const leave of [false, true]) {
    test(`app-edit ${status} respects ${leave ? "a newer Settings view" : "its current view"}`, async () => {
      const row = session("app-edit", { threadRef: "web:tester:app-edit:example" });
      let release: ((response: Response) => void) | undefined;
      let response: Response;
      const h = await harness({
        path: "/app-edit?slug=example",
        session: row,
        listSessions: [row],
        onRequest: (path, init) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const rows = [row] as unknown as Session[];
          if (path === "/api/session-navigation")
            return Response.json(projectSessionNavigation(rows, rows, [], "tester", body));
          if (path !== "/api/session-navigation/resolve") return;
          response =
            status === 200
              ? Response.json(resolveSessionReferences(rows, body.references))
              : Response.json({ error: "denied" }, { status });
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        },
      });
      let boot: Promise<void> | undefined;
      try {
        boot = h.boot();
        await until(() => Boolean(release));
        if (leave) h.switchView("settings");
        release!(response!);
        await boot;
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(h.appState.currentView, leave ? "settings" : "chats");
        if (leave) assert.doesNotMatch(h.mainText(), /Couldn't load this app conversation/);
        else if (status === 200) assert.equal(h.visibleConversation().state.sessionId, row.id);
        else assert.match(h.mainText(), /Couldn't load this app conversation/);
      } finally {
        if (release) release(response!);
        await Promise.allSettled([boot]);
        await h.close();
      }
    });
  }
}

test("denied initial navigation stays visibly failed and retries the bounded route", async () => {
  const m = model();
  let denied = true;
  m.intercept((path) =>
    path === "/api/session-navigation" && denied ? Response.json({ error: "denied" }, { status: 403 }) : undefined,
  );
  const h = await harness({ path: "/", welcome: true, onRequest: m.onRequest });
  try {
    await h.boot();
    assert.equal(h.sessionsState.loaded, false);
    assert.equal(document.querySelector('[data-session-navigation="error"]') !== null, true);
    assert.equal(h.requests.includes("/api/sessions"), false);
    denied = false;
    click('[data-session-navigation="error"] button.btn');
    await until(() => document.querySelector('[data-session-navigation="ready"]') !== null);
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});

test("a continuation pending during live refresh cannot restore stale membership or expand the refreshed window", async () => {
  const m = model();
  const h = await harness({ path: "/settings", listSessions: m.rows, contexts: m.contexts, onRequest: m.onRequest });
  try {
    await h.boot();
    await h.sessionsReady();
    let complete!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    let stale: unknown;
    m.intercept((path, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (path === "/api/session-navigation" && body.section === "pinned" && body.cursor && !complete) {
        signal = init?.signal;
        stale = projectSessionNavigation(
          m.rows as unknown as Session[],
          m.rows as unknown as Session[],
          m.contexts as unknown as ContextSummary[],
          "tester",
          body,
        );
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }
      return undefined;
    });
    click('[data-session-page="pinned"]');
    await until(() => Boolean(complete));
    m.rows.splice(
      m.rows.findIndex((row) => row.id === "pin-064"),
      1,
    );
    assert.equal(await h.refreshSessions(), true);
    assert.equal(signal?.aborted, true);
    assert.equal(document.querySelectorAll(".pinned-children [data-session-id]").length, 50);
    assert.equal(document.querySelector("[data-session-navigation]")?.getAttribute("data-session-pinned-total"), "64");
    complete(Response.json(stale));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(document.querySelectorAll(".pinned-children [data-session-id]").length, 50);
    assert.equal(document.querySelector('[data-session-id="pin-064"]'), null);
  } finally {
    await h.close();
  }
});

test("a Slack deep link invalidates a pending first web-only snapshot", async () => {
  const slack = session("slack", { threadRef: "dm:tester:slack", surface: "slack", lastActivityAt: 2 });
  const web = session("web", { surface: "web", lastActivityAt: 1 });
  const rows = [slack, web] as unknown as Session[];
  const calls: { body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  let release: (() => void) | undefined;
  const h = await harness({
    path: "/s/slack",
    session: slack,
    listSessions: rows,
    onRequest: (path, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (path === "/api/session-navigation/resolve")
        return Response.json(resolveSessionReferences(rows, body.references));
      if (path !== "/api/session-navigation") return;
      calls.push({ body, signal: init?.signal });
      const response = () => Response.json(projectSessionNavigation(rows, rows, [], "tester", body));
      if (calls.length === 1)
        return new Promise<Response>((resolve) => {
          release = () => resolve(response());
        });
      return response();
    },
  });
  let boot: Promise<void> | undefined;
  try {
    boot = h.boot();
    await until(() => Boolean(release) && !h.sessionsState.webOnly);
    assert.equal(calls[0]!.body.surface, "web");
    assert.equal(calls[0]!.signal?.aborted, true);
    assert.deepEqual([h.sessionsState.navigation], [null]);
    release!();
    await boot;
    await h.sessionsReady();
    assert.deepEqual(
      calls.map((call) => call.body.surface),
      ["web", "all"],
    );
    assert.deepEqual(
      h.sessionsState.navigation?.recent.items.map((row) => row.id),
      ["slack", "web"],
    );
    assert.equal(document.querySelector("[data-session-navigation]")?.getAttribute("data-session-navigation"), "ready");
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    release?.();
    await Promise.allSettled([boot]);
    await h.close();
  }
});

for (const initialWebOnly of [false, true]) {
  for (const reset of [false, true]) {
    test(`pending ${initialWebOnly ? "web-to-all" : "all-to-web"} filter change survives ${reset ? "actor reset" : "its old response"}`, async () => {
      const rows = [session("slack", { threadRef: "dm:tester:slack", lastActivityAt: 2 }), session("web")];
      const pending: { body: Record<string, unknown>; signal?: AbortSignal | null; release: () => void }[] = [];
      const h = await harness({
        path: "/settings",
        onRequest: (path, init) => {
          if (path !== "/api/session-navigation") return;
          const body = JSON.parse(String(init?.body));
          return new Promise<Response>((resolve) => {
            pending.push({
              body,
              signal: init?.signal,
              release: () =>
                resolve(
                  Response.json(projectSessionNavigation(rows as Session[], rows as Session[], [], "tester", body)),
                ),
            });
          });
        },
      });
      let first: Promise<boolean> | undefined;
      let fresh: Promise<boolean> | undefined;
      try {
        h.setWebOnly(initialWebOnly);
        first = h.refreshSessions();
        await until(() => pending.length === 1);
        h.setWebOnly(!initialWebOnly);
        assert.equal(pending[0]!.signal?.aborted, true);
        if (reset) {
          h.resetSessions();
          fresh = h.refreshSessions();
        }
        pending[0]!.release();
        await until(() => pending.length === 2);
        assert.deepEqual([h.sessionsState.navigation], [null]);
        assert.equal(h.sessionsState.loaded, false);
        const expectedSurface = initialWebOnly ? "all" : "web";
        assert.equal(pending[1]!.body.surface, expectedSurface);
        pending[1]!.release();
        await Promise.all([first, fresh]);
        assert.equal(pending.length, 2);
        assert.deepEqual(
          h.sessionsState.navigation?.recent.items.map((row) => row.id),
          initialWebOnly ? ["web", "slack"] : ["web"],
        );
        assert.equal(h.sessionsState.loaded, true);
        assert.equal(h.requests.includes("/api/sessions"), false);
      } finally {
        for (const request of pending) request.release();
        await Promise.allSettled([first, fresh]);
        await h.close();
      }
    });
  }
}

test("a failed replacement surface read cannot apply the old successful initial snapshot", async () => {
  const row = session("web");
  let release: (() => void) | undefined;
  let calls = 0;
  const h = await harness({
    path: "/settings",
    onRequest: (path, init) => {
      if (path !== "/api/session-navigation") return;
      const body = JSON.parse(String(init?.body));
      if (++calls > 1) return Response.json({ error: "denied" }, { status: 403 });
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(Response.json(projectSessionNavigation([row] as Session[], [row] as Session[], [], "tester", body)));
      });
    },
  });
  let first: Promise<boolean> | undefined;
  try {
    first = h.refreshSessions();
    await until(() => Boolean(release));
    h.setWebOnly(false);
    release!();
    assert.equal(await first, false);
    assert.equal(calls, 2);
    assert.equal(h.sessionsState.loaded, false);
    assert.deepEqual([h.sessionsState.navigation], [null]);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    release?.();
    await Promise.allSettled([first]);
    await h.close();
  }
});

test("changing the surface of a settled legacy list keeps client-side filtering without another full read", async () => {
  const h = await harness({ path: "/settings", listSessions: [session("web")] });
  try {
    h.releaseSessions();
    assert.equal(await h.refreshSessions(), true);
    const before = [...h.requests];
    h.setWebOnly(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(h.requests, before);
    assert.equal(h.sessionsState.webOnly, false);
    assert.deepEqual([h.sessionsState.navigation], [null]);
  } finally {
    await h.close();
  }
});
