import { JSDOM } from "jsdom";
import { createServer } from "vite";

export interface Harness {
  requests: string[];
  setConnections: (items: unknown[], status?: number) => void;
  releaseSessions: () => void;
  releaseTranscript: () => void;
  releaseApprovals: () => void;
  sessionsReady: () => Promise<void>;
  boot: () => Promise<void>;
  appState: { currentView: string };
  sessionsState: { list: Array<{ id: string }>; loaded: boolean; openingKey: string | null };
  visibleConversation: () => { state: { sessionId: string | null; threadRef: string | null } };
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
  savedCanvas?: boolean;
  welcome?: boolean;
  connectionReturn?: boolean;
  returnWidget?: string;
}

export const SESSION = {
  id: "sess-deep",
  threadRef: "web:tester:deep",
  scopeId: "personal:tester",
  title: "Deep linked chat",
};

export async function harness(opts: HarnessOptions): Promise<Harness> {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: `http://localhost${opts.path}`,
    pretendToBeVisual: true,
  });
  if (opts.savedCanvas)
    dom.window.localStorage.setItem(
      "web-ui:split-canvas:v1",
      JSON.stringify({
        v: 1,
        active: true,
        root: {
          kind: "split",
          a: { kind: "leaf", threadRef: "web:tester:old-a" },
          b: { kind: "leaf", threadRef: "web:tester:old-b" },
        },
      }),
    );
  let connectedItems: unknown[] = opts.connectionReturn ? [{ id: "ca_test", toolkit: "gmail" }] : [];
  let connectedStatus = 200;
  if (opts.connectionReturn)
    dom.window.sessionStorage.setItem(
      "qm-connection-return:test:tester",
      JSON.stringify({
        state: "return-nonce",
        user: "test:tester",
        path: "/s/sess-deep",
        service: { id: "gmail", name: "Gmail" },
        accountId: "ca_test",
        widget: opts.returnWidget ?? "welcome",
        expiresAt: Date.now() + 60000,
        picker: { query: "mail", expanded: true },
        scrollTop: 0,
      }),
    );
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
    if (path === "/me")
      return Response.json({
        user: "tester",
        org: "test",
        permissions: [],
        ...(opts.welcome ? { welcomeCohort: "F26" } : {}),
      });
    if (path.startsWith("/api/composio/connections"))
      return Response.json({ items: connectedItems, nextCursor: null }, { status: connectedStatus });
    if (path.startsWith("/api/composio/toolkits"))
      return Response.json({ items: [{ id: "gmail", name: "Gmail", description: "Email" }], nextCursor: null });
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
    sessionStorage: dom.window.sessionStorage,
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
    setConnections: (items, status = 200) => {
      connectedItems = items;
      connectedStatus = status;
    },
    releaseSessions,
    releaseTranscript,
    releaseApprovals,
    sessionsReady: sessions.sessionsReady as () => Promise<void>,
    boot: shell.boot as () => Promise<void>,
    appState: shell.appState as Harness["appState"],
    sessionsState: sessions.sessionsState as Harness["sessionsState"],
    visibleConversation: () =>
      conversations
        .allConversations()
        .find((conv: { state: { host: HTMLElement | null } }) => conv.state.host?.isConnected) ??
      conversations.mainConversation(),
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
