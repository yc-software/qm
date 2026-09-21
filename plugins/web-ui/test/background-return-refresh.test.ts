import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { metadata } from "./model-metadata.ts";
import type { Conversation } from "../src/conv-types.ts";
import type { SessionEntry } from "../src/core-bridge.ts";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 160));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("a backgrounded chat shows the response that completed while it was away", async (t) => {
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
  const row = {
    id: "s1",
    threadRef: "web:owner:repro",
    scopeId: "personal:owner",
    title: "Backgrounded chat",
    type: "dm",
    createdAt: Date.now(),
  };
  const other = { ...row, id: "s2", threadRef: "web:owner:other", title: "Other chat" };
  const question = "Please answer while I lock the phone";
  const reply = "The response that finished while you were away.";
  const user: SessionEntry = { seq: 0, type: "user", createdAt: Date.now(), payload: { text: question } };
  const completed: SessionEntry[] = [
    user,
    { seq: 1, type: "assistant", createdAt: Date.now(), payload: { text: reply } },
  ];
  let entries: SessionEntry[] = [user];
  let activeRun: unknown = { runId: null, run: null, queued: [] };
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
        scopeId: row.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["test-model"] },
        modelCatalog: { "test-model": metadata("test-model", "Test model") },
        orgDefault: { harnessId: "pi", modelId: "test-model", revision: 0 },
        effective: { harnessId: "pi", modelId: "test-model" },
        scopeOverride: null,
      });
    if (path.includes("/api/runs/active")) return Response.json(activeRun);
    if (path === "/api/turn") return Response.json({ runId: "r9" });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path.startsWith("/api/sessions/s2")) return Response.json({ session: other, entries: [], earlierEntries: 0 });
    if (path.startsWith("/api/sessions/s1")) return Response.json({ session: row, entries, earlierEntries: 0 });
    if (path === "/api/sessions") return Response.json({ sessions: [row, other] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  let conv: Conversation | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation, disposeConversation, ensureDeliveryStream } =
      await vite.ssrLoadModule("/src/conversations.ts");
    const { entriesToMessages } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    seedRuntimeConfig(row.scopeId, await (await fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = [row, other];
    sessionsState.loaded = true;
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    ensureDeliveryStream();
    const delivery = FakeEventSource.instances.find((es) => es.url === "/api/deliveries/events")!;
    const setVisibility = (state: string) =>
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    const returnToTab = () => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const rendered = (text: string) =>
      [...host.querySelectorAll(".assistant-body > .streaming-text, .work-said, .user-bubble")].filter((el) =>
        el.textContent?.includes(text),
      ).length;
    async function mount(): Promise<void> {
      if (conv) disposeConversation(conv);
      entries = [user];
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
        row.threadRef,
        row.id,
        row.scopeId,
        entriesToMessages([user], transcriptModel()),
        null,
        row as never,
      );
      conv.state.agent!.convertToLlm = () => [{ role: "user", content: question, timestamp: 0 }];
      await settle();
      requests.length = 0;
    }
    async function quiesce(): Promise<void> {
      let seen = -1;
      while (seen !== requests.length) {
        seen = requests.length;
        await settle();
      }
    }
    async function leaveTab(): Promise<void> {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    }
    async function background(): Promise<void> {
      entries = completed;
      await leaveTab();
    }
    for (const [label, run] of [
      ["absent", { runId: null, run: null, queued: [] }],
      ["terminal", { runId: "r1", run: { status: "running", replyComplete: true }, queued: [] }],
    ] as const) {
      await t.test(`a ${label} active run falls back to the transcript catch-up`, async () => {
        activeRun = run;
        await mount();
        const streams = FakeEventSource.instances.length;
        await background();
        assert.equal(rendered(reply), 0, "the reply must not be on screen before the tab comes back");
        returnToTab();
        await until(() => rendered(reply) === 1);
        assert.equal(rendered(question), 1, "the pre-background message must not be duplicated");
        assert.ok(
          requests.some((path) => path.startsWith("/api/runs/active")) &&
            requests.some((path) => path.startsWith("/api/sessions/s1")),
          `expected the active-run check and a transcript refetch, saw ${requests.join(", ")}`,
        );
        assert.equal(requests.filter((path) => path === "/api/turn").length, 0, "returning must not start a new turn");
        assert.equal(FakeEventSource.instances.length, streams, "returning must not open a run stream");
      });
    }
    await t.test("a run still live on return is attached, and the stream survives the return", async () => {
      activeRun = { runId: null, run: null, queued: [] };
      await mount();
      await leaveTab();
      activeRun = { runId: "r2", run: { status: "running" }, queued: [{ runId: "r3", text: "next one" }] };
      returnToTab();
      await until(() => FakeEventSource.instances.some((es) => es.url === "/api/runs/r2/events"));
      const stream = FakeEventSource.instances.findLast((es) => es.url === "/api/runs/r2/events")!;
      stream.onopen?.();
      stream.emit("partial", { partial: "half a thought" });
      await until(() => rendered("half a thought") === 1);
      assert.deepEqual(
        conv!.composer.queuedRunsFor(row.threadRef).map((r) => r.runId),
        ["r3"],
      );
      await quiesce();
      requests.length = 0;
      returnToTab();
      await settle();
      assert.deepEqual(requests, [], "a return mid-stream must not refetch the transcript");
      assert.equal(rendered("half a thought"), 1, "the live stream must survive the return");
      entries = completed;
      activeRun = { runId: null, run: null, queued: [] };
      stream.emit("done", { status: "done", result: { status: "silent", sessionId: row.id }, activity: [] });
      await until(() => rendered(reply) === 1);
    });
    await t.test("an SSE reconnect catches up a visible transcript", async () => {
      activeRun = { runId: null, run: null, queued: [] };
      await mount();
      entries = completed;
      delivery.onopen?.();
      delivery.onopen?.();
      await until(() => rendered(reply) === 1);
      assert.ok(
        requests.includes("/api/sessions"),
        `a resync must still refresh the sessions list, saw ${requests.join(", ")}`,
      );
    });
    await t.test("switching chats during the active-run check leaves the new chat alone", async () => {
      activeRun = { runId: null, run: null, queued: [] };
      await mount();
      let release!: () => void;
      const pending = new Promise<Response>((resolve) => {
        release = () => resolve(Response.json(activeRun));
      });
      intercept = (path) => (path.startsWith("/api/runs/active") ? pending : undefined);
      await background();
      returnToTab();
      await until(() => requests.some((path) => path.startsWith("/api/runs/active")));
      intercept = undefined;
      conv!.mountContinuable(other.threadRef, other.id, other.scopeId, [], null, other as never);
      await quiesce();
      requests.length = 0;
      release();
      await settle();
      assert.equal(rendered(reply), 0, "the other chat must not receive the backgrounded chat's reply");
      assert.equal(conv!.state.sessionId, other.id);
      assert.deepEqual(
        requests.filter((path) => path.startsWith("/api/sessions/")),
        [],
        "the stale resume must refresh neither the chat it left nor the one now mounted",
      );
    });
    if (conv) {
      disposeConversation(conv);
      conv = undefined;
    }
  } finally {
    conv?.state.agent?.abort();
    await conv?.state.agent?.waitForIdle();
    conv?.composer.dispose();
    conv?.dispose();
    for (const es of FakeEventSource.instances) es.close();
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
