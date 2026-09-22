import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { metadata } from "../model-metadata.ts";
import type { Conversation } from "../../src/conv-types.ts";
import type { CoreSession, SessionEntry } from "../../src/core-bridge.ts";

interface FakeDeliveryStream {
  url: string;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  closed: boolean;
  addEventListener(name: string, listener: (event: { data: string }) => void): void;
  emit(name: string, data: unknown): void;
  close(): void;
}

interface DeliveryStreamHarnessOptions {
  sessions: CoreSession[];
  transcript(id: string): SessionEntry[];
  activeRun(): unknown;
  convertToLlm?: NonNullable<Conversation["state"]["agent"]>["convertToLlm"];
}

interface DeliveryStreamHarness {
  intercept?: (path: string) => Promise<Response> | undefined;
  requests: string[];
  streams: FakeDeliveryStream[];
  delivery: FakeDeliveryStream;
  mount(): Promise<Conversation>;
  rendered(text: string): number;
  setVisibility(state: string): void;
  returnToTab(): void;
  leaveTab(): Promise<void>;
  quiesce(): Promise<void>;
  settle(): Promise<unknown>;
  until(check: () => boolean): Promise<void>;
  dispose(): Promise<void>;
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 160));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

export async function openDeliveryStreamHarness(options: DeliveryStreamHarnessOptions): Promise<DeliveryStreamHarness> {
  const sessions = options.sessions;
  const primary = sessions[0];
  const streams: FakeDeliveryStream[] = [];
  class FakeEventSource implements FakeDeliveryStream {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners = new Map<string, Array<(event: { data: string }) => void>>();
    closed = false;
    url: string;
    constructor(url: string) {
      this.url = url;
      streams.push(this);
    }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    emit(name: string, data: unknown) {
      for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', { url: "http://localhost/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
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
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: FakeEventSource,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let intercept: ((path: string) => Promise<Response> | undefined) | undefined;
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = String(input);
    requests.push(path);
    const intercepted = intercept?.(path);
    if (intercepted) return intercepted;
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId: primary.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["test-model"] },
        modelCatalog: { "test-model": metadata("test-model", "Test model") },
        orgDefault: { harnessId: "pi", modelId: "test-model", revision: 0 },
        effective: { harnessId: "pi", modelId: "test-model" },
        scopeOverride: null,
      });
    if (path.includes("/api/runs/active")) return Response.json(options.activeRun());
    if (path === "/api/turn") return Response.json({ runId: "r9" });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    const session = sessions.find((candidate) => path.startsWith(`/api/sessions/${candidate.id}`));
    if (session) return Response.json({ session, entries: options.transcript(session.id), earlierEntries: 0 });
    if (path === "/api/sessions") return Response.json({ sessions });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let conv: Conversation | undefined;
  let disposeConversation: ((conv: Conversation) => void) | undefined;
  const teardown = async (): Promise<void> => {
    conv?.state.agent?.abort();
    await conv?.state.agent?.waitForIdle();
    if (conv) disposeConversation?.(conv);
    conv = undefined;
    for (const es of streams) es.close();
    await vite?.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
  };
  try {
    vite = await createServer({
      root: fileURLToPath(new URL("../..", import.meta.url)),
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const conversations = await vite.ssrLoadModule("/src/conversations.ts");
    const { createConversation, ensureDeliveryStream } = conversations;
    disposeConversation = conversations.disposeConversation;
    const { entriesToMessages } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    seedRuntimeConfig(primary.scopeId, await (await fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = sessions;
    sessionsState.loaded = true;
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    ensureDeliveryStream();
    const delivery = streams.find((es) => es.url === "/api/deliveries/events")!;
    const setVisibility = (state: string): void => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    };
    const rendered = (text: string): number =>
      [...host.querySelectorAll(".assistant-body > .streaming-text, .work-said, .user-bubble")].filter((el) =>
        el.textContent?.includes(text),
      ).length;
    const returnToTab = (): void => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const leaveTab = async (): Promise<void> => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    };
    const quiesce = async (): Promise<void> => {
      let seen = -1;
      while (seen !== requests.length) {
        seen = requests.length;
        await settle();
      }
    };
    const mount = async (): Promise<Conversation> => {
      if (conv) disposeConversation?.(conv);
      setVisibility("visible");
      conv = createConversation({
        pane: true,
        ownsUrl: false,
        container: () => host,
        claimContainer: () => host,
        visible: () => true,
        density: () => "full",
        onDensityChange() {},
        ensureDeliveryStream,
      }) as Conversation;
      conv.mountContinuable(
        primary.threadRef,
        primary.id,
        primary.scopeId,
        entriesToMessages(options.transcript(primary.id), transcriptModel()),
        null,
        primary,
      );
      if (options.convertToLlm) conv.state.agent!.convertToLlm = options.convertToLlm;
      await settle();
      requests.length = 0;
      return conv;
    };
    return {
      get intercept() {
        return intercept;
      },
      set intercept(value) {
        intercept = value;
      },
      requests,
      streams,
      delivery,
      mount,
      rendered,
      setVisibility,
      returnToTab,
      leaveTab,
      quiesce,
      settle,
      until,
      dispose: teardown,
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}
