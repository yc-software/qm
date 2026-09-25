import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
test("session refresh bursts share one trailing read and observe its fresh list", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const sessionA = {
    id: "sess-a",
    threadRef: "web:alex:aaa",
    scopeId: "personal:alex",
    title: "Review sample workspace",
  };
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/sessions") return new Promise<Response>((resolve) => pending.push(resolve));
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState, sessionsReady, refreshSessions } = await vite.ssrLoadModule("/src/sessions.ts");
    appState.me = { user: "alex", org: "acme" };
    const boot = refreshSessions({ silent: true });
    const pane1 = (async () => {
      const refreshed = await refreshSessions({ silent: true });
      return { refreshed, found: sessionsState.list.some((s: { id: string }) => s.id === sessionA.id) };
    })();
    const pane2 = refreshSessions({ silent: true });

    let ready = false;
    const readiness = sessionsReady().then(() => {
      ready = true;
    });

    assert.equal(pending.length, 1, "a burst must not run overlapping session reads");
    pending[0]!(Response.json({ sessions: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pending.length, 2, "one trailing read observes changes newer than the first snapshot");
    assert.equal(ready, false, "sessionsReady() must wait for the fresh read");
    pending[1]!(Response.json({ sessions: [sessionA] }));
    assert.equal(await pane2, true, "the winning refresh reports success");
    assert.equal(await boot, true, "a superseded refresh resolves with the winner's outcome");
    const p1 = await pane1;
    assert.equal(p1.refreshed, true);
    assert.equal(p1.found, true, "a superseded awaiter sees the session — no empty read-only stub");
    await readiness;
    assert.ok(sessionsState.list.some((s: { id: string }) => s.id === sessionA.id));
  } finally {
    await vite.close();
  }
});

test("a failed lone refresh still settles sessionsReady and reports the error path", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error("network down");
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { sessionsReady, refreshSessions } = await vite.ssrLoadModule("/src/sessions.ts");
    assert.equal(await refreshSessions({ silent: true }), false);
    await sessionsReady();
  } finally {
    await vite.close();
  }
});

function jsdomGlobals(): JSDOM {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return dom;
}

test("opening a conversation joins the list refresh already in flight instead of starting its own", async () => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/sessions") return new Promise<Response>((resolve) => pending.push(resolve));
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen, sessionsReady } = await vite.ssrLoadModule("/src/sessions.ts");
    const first = refreshSessions({ showLoading: true });
    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    assert.equal(pending.length, 1, "the first list load answers every conversation opened while it runs");

    pending[0]!(Response.json({ sessions: [] }));
    assert.equal(await first, true);
    await sessionsReady();

    refreshSessionsOnOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pending.length, 2, "once it has landed, opening a conversation freshens the list again");

    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    assert.equal(pending.length, 2, "…and panes restored together still share one refresh, loaded list or not");
    pending[1]!(Response.json({ sessions: [] }));
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("a failed list load does not lock out the next conversation open", async () => {
  const dom = jsdomGlobals();
  let hits = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    hits++;
    throw new Error("network down");
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    assert.equal(await refreshSessions({ showLoading: true }), false);
    assert.equal(sessionsState.loaded, false);
    refreshSessionsOnOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hits, 2, "nothing is in flight to defer to — the open must retry");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("an open that joined a refresh whose answer was discarded asks again itself", async () => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/sessions") return new Promise<Response>((resolve) => pending.push(resolve));
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const stale = refreshSessions({ silent: true, patchEpoch: -1 });
    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    assert.equal(pending.length, 1, "both opens join the refresh already running");

    pending[0]!(Response.json({ sessions: [{ id: "b", threadRef: "web:alex:b", scopeId: "personal:alex" }] }));
    assert.equal(await stale, false, "a patch landing mid-flight makes a refresh discard its answer");
    assert.equal(sessionsState.list.length, 0, "so the list it fetched never reaches the sidebar");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(pending.length, 2, "the opens that joined it ask again — once between them, not once each");
    pending[1]!(Response.json({ sessions: [{ id: "b", threadRef: "web:alex:b", scopeId: "personal:alex" }] }));
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("an open that joined a refresh that simply failed does not double the load", async () => {
  const dom = jsdomGlobals();
  let hits = 0;
  let fail = (): void => {};
  const failed = new Promise<void>((resolve) => (fail = resolve));
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    hits++;
    await failed;
    throw new Error("network down");
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, refreshSessionsOnOpen } = await vite.ssrLoadModule("/src/sessions.ts");
    const doomed = refreshSessions({ silent: true });
    refreshSessionsOnOpen();
    refreshSessionsOnOpen();
    fail();
    assert.equal(await doomed, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hits, 1, "a refresh that failed is not worth asking three more times while the server is down");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("queued refreshes recover a failed read and retain the latest patch epoch", async () => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
    return new Promise<Response>((resolve) => pending.push(resolve));
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const first = refreshSessions({ silent: true });
    const outdated = refreshSessions({ silent: true, patchEpoch: -1 });
    const current = refreshSessions({ silent: true });
    assert.equal(pending.length, 1);
    pending[0]!(Response.json({ error: "unavailable" }, { status: 503 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pending.length, 2);
    const session = { id: "s", threadRef: "web:alex:s", scopeId: "personal:alex", title: "Current" };
    pending[1]!(Response.json({ sessions: [session] }));
    assert.deepEqual(await Promise.all([first, outdated, current]), [true, true, true]);
    assert.equal(sessionsState.list[0]?.title, "Current");

    const started = refreshSessions({ silent: true });
    const stale = refreshSessions({ silent: true, patchEpoch: -1 });
    pending[2]!(Response.json({ sessions: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[3]!(Response.json({ sessions: [{ ...session, title: "Stale" }] }));
    assert.deepEqual(await Promise.all([started, stale]), [false, false]);
    assert.equal(sessionsState.list[0]?.title, "Current", "a queued obsolete patch recovery cannot overwrite state");
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("a stalled refresh can be replaced without old requests trapping later refreshes", async (t) => {
  const dom = jsdomGlobals();
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
    return new Promise<Response>((resolve) => pending.push(resolve));
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { refreshSessions, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const stalled = refreshSessions({ silent: true });
    const queued = refreshSessions({ silent: true });
    now += 10_001;
    const replacement = refreshSessions({ silent: true });
    assert.equal(pending.length, 2, "a stalled request must not hold every caller indefinitely");
    const session = { id: "s", threadRef: "web:alex:s", scopeId: "personal:alex", title: "Replacement" };
    pending[1]!(Response.json({ sessions: [session] }));
    assert.equal(await replacement, true);
    const fresh = refreshSessions({ silent: true });
    assert.equal(pending.length, 3, "the stalled request cannot make a finished replacement look active");
    pending[2]!(Response.json({ sessions: [{ ...session, title: "Fresh" }] }));
    assert.equal(await fresh, true);
    pending[0]!(Response.json({ sessions: [] }));
    assert.deepEqual(await Promise.all([stalled, queued]), [true, true]);
    assert.equal(sessionsState.list[0]?.title, "Fresh");
    assert.equal(pending.length, 3, "the abandoned queued refresh must not run after its replacement");
  } finally {
    await vite.close();
    dom.window.close();
  }
});
