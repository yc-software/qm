import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

interface Harness {
  requests: string[];
  releaseSessions: () => void;
  releaseTranscript: () => void;
  releaseApprovals: () => void;
  sessionsReady: () => Promise<void>;
  boot: () => Promise<void>;
  appState: { currentView: string };
  sessionsState: { list: Array<{ id: string }>; loaded: boolean; openingKey: string | null };
  mainConversation: () => { state: { sessionId: string | null; threadRef: string | null } };
  mainText: () => string;
  close: () => Promise<void>;
}

interface HarnessOptions {
  path: string;
  transcriptStatus?: number;
  transcriptFailures?: number;
  holdTranscript?: boolean;
  holdApprovals?: boolean;
  listSessions?: unknown[];
}

const SESSION = {
  id: "sess-deep",
  threadRef: "web:tester:deep",
  scopeId: "personal:tester",
  title: "Deep linked chat",
};

async function harness(opts: HarnessOptions): Promise<Harness> {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: `http://localhost${opts.path}` });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const requests: string[] = [];
  const inFlight = new Set<Promise<Response>>();
  let releaseSessions = (): void => {};
  let releaseTranscript = (): void => {};
  let releaseApprovals = (): void => {};
  const approvalsHeld = new Promise<void>((resolve) => (releaseApprovals = resolve));
  const sessionsHeld = new Promise<void>((resolve) => (releaseSessions = resolve));
  const transcriptHeld = new Promise<void>((resolve) => (releaseTranscript = resolve));
  let failuresLeft = opts.transcriptFailures ?? (opts.transcriptStatus ? Number.POSITIVE_INFINITY : 0);
  const respond = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    requests.push(path);
    if (path === "/me") return Response.json({ user: "tester", org: "test", permissions: [] });
    if (path.startsWith("/api/runtime-config")) {
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        orgDefault: { harnessId: "pi", modelId: "m", revision: 1 },
        scopeOverride: null,
        effective: { harnessId: "pi", modelId: "m" },
        upgradeAvailable: false,
      });
    }
    if (path.startsWith("/api/ui-state")) return Response.json({ value: null, updatedAt: 0 });
    if (path.startsWith("/api/sessions/") && path.includes("/approvals")) {
      if (opts.holdApprovals) await approvalsHeld;
      return Response.json({ approvals: [] });
    }
    if (path.startsWith(`/api/sessions/${SESSION.id}`)) {
      if (opts.holdTranscript) await transcriptHeld;
      if (failuresLeft > 0) {
        failuresLeft--;
        return Response.json({ error: "not_found" }, { status: opts.transcriptStatus ?? 500 });
      }
      return Response.json({ session: SESSION, entries: [] });
    }
    if (path === "/api/sessions") {
      await sessionsHeld;
      return Response.json({ sessions: opts.listSessions ?? [] });
    }
    return Response.json({ contexts: [], items: [], crons: [] });
  };

  const globals = {
    fetch: (input: RequestInfo | URL): Promise<Response> => {
      const answer = respond(input);
      inFlight.add(answer);
      void answer.finally(() => inFlight.delete(answer)).catch(() => {});
      return answer;
    },
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    cancelAnimationFrame: clearTimeout,
    EventSource: undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    setTimeout: ((...args: Parameters<typeof setTimeout>) => {
      const id = realSetTimeout(...args);
      timers.add(id);
      return id;
    }) as typeof setTimeout,
    setInterval: ((...args: Parameters<typeof setInterval>) => {
      const id = realSetInterval(...args);
      timers.add(id);
      return id;
    }) as typeof setInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = realSetTimeout(() => callback(Date.now()), 0);
      timers.add(id);
      return id as unknown as number;
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });

  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  const shell = await vite.ssrLoadModule("/src/shell.ts");
  const sessions = await vite.ssrLoadModule("/src/sessions.ts");
  const conversations = await vite.ssrLoadModule("/src/conversations.ts");
  return {
    requests,
    releaseSessions,
    releaseTranscript,
    releaseApprovals,
    sessionsReady: sessions.sessionsReady as () => Promise<void>,
    boot: shell.boot as () => Promise<void>,
    appState: shell.appState as Harness["appState"],
    sessionsState: sessions.sessionsState as Harness["sessionsState"],
    mainConversation: conversations.mainConversation as Harness["mainConversation"],
    mainText: () => dom.window.document.querySelector(".main")?.textContent ?? "",
    close: async () => {
      releaseSessions();
      releaseTranscript();
      releaseApprovals();
      for (let drain = 0; drain < 5 && inFlight.size; drain++) {
        await Promise.allSettled(inFlight);
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
      await vite.close();
      dom.window.close();
      for (const id of timers) clearTimeout(id);
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test("a share link paints its conversation from the transcript, without waiting for the session list", async () => {
  const h = await harness({ path: "/s/sess-deep" });
  try {
    await h.boot();
    assert.equal(h.sessionsState.loaded, false, "the sidebar list must still be in flight");
    assert.equal(h.mainConversation().state.sessionId, SESSION.id, "the linked chat is already mounted");
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [SESSION.id],
      "the row the transcript carried seeds the list, so the header has its title",
    );
    assert.match(h.mainText(), /Deep linked chat/);
    assert.equal(
      h.requests.filter((p) => p === "/api/sessions").length,
      1,
      "boot must not stampede the expensive list route",
    );
    const transcript = h.requests.indexOf(`/api/sessions/${SESSION.id}?tailTurns=25`);
    assert.ok(transcript >= 0, "the transcript is fetched with the tail window");
    assert.ok(transcript < h.requests.indexOf("/me"), "and is in flight before /me is even asked");
    const approvals = h.requests.indexOf(`/api/sessions/${SESSION.id}/approvals`);
    assert.ok(approvals >= 0, "the pending approvals the mount needs are fetched too");
    assert.ok(approvals < h.requests.indexOf("/me"), "…in the same first round trip, not a serial one after it");
    assert.ok(
      h.requests.indexOf("/api/runtime-config") < h.requests.indexOf("/me"),
      "runtime-config rides the same round trip rather than queueing behind /me",
    );
  } finally {
    await h.close();
  }
});

test("a share link whose transcript 404s falls back to the session list", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true, "the fallback waits for the list");
    assert.equal(h.mainConversation().state.sessionId, null, "no conversation is mounted");
    assert.match(h.mainText(), /wasn't found, or you don't have access to it/);
  } finally {
    await h.close();
  }
});

test("a share link whose transcript fetch flakes still opens from the session list", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    transcriptStatus: 503,
    transcriptFailures: 1,
    listSessions: [SESSION],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.mainConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a session list that wins the race keeps its own decorated rows", async () => {
  const listed = { ...SESSION, working: true };
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", holdTranscript: true, listSessions: [other, listed] });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseTranscript();
    await booted;
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [other.id, SESSION.id],
      "the list the server sent keeps its order — the transcript's copy must not jump the queue",
    );
    assert.equal(
      (h.sessionsState.list.find((s) => s.id === SESSION.id) as { working?: boolean }).working,
      true,
      "…nor strip the decorations only the list route computes",
    );
    assert.equal(h.mainConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a list that omits the open conversation does not drop its row", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", listSessions: [other] });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    assert.equal(h.mainConversation().state.sessionId, SESSION.id);
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the conversation the user is reading must keep its sidebar row",
    );
  } finally {
    await h.close();
  }
});

test("a list landing mid-open still keeps the row of the conversation being opened", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", holdApprovals: true, listSessions: [other] });
  try {
    const booted = h.boot();
    while (!h.sessionsState.openingKey) await new Promise((resolve) => setTimeout(resolve, 0));
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseApprovals();
    await booted;
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the row must survive a refresh that lands between the open starting and the mount finishing",
    );
  } finally {
    await h.close();
  }
});

test("a bare entry still mints a new chat once the list lands", async () => {
  const h = await harness({ path: "/" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.appState.currentView, "chats");
    assert.equal(h.mainConversation().state.sessionId, null);
    assert.ok(h.mainConversation().state.threadRef, "a fresh chat is mounted");
  } finally {
    await h.close();
  }
});

test("a view deep link still waits for the list and never fetches a transcript", async () => {
  const h = await harness({ path: "/crons" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.appState.currentView, "crons");
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.requests.filter((p) => p.startsWith(`/api/sessions/${SESSION.id}`)).length, 0);
  } finally {
    await h.close();
  }
});
