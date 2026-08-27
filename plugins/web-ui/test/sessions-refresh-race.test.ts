import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
test("superseded session refreshes observe the winning refresh's list", async () => {
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
    threadRef: "web:alice:aaa",
    scopeId: "personal:alice",
    title: "Optimize QM webapp",
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
    appState.me = { user: "alice", org: "acme" };
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

    assert.equal(pending.length, 3, "three /api/sessions requests in flight");
    const body = () => Response.json({ sessions: [sessionA] });
    pending[0]!(body());
    pending[1]!(body());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ready, false, "sessionsReady() must wait for a winning refresh");
    pending[2]!(body());
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
