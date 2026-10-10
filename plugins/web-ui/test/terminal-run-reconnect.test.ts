import assert from "node:assert/strict";
import test from "node:test";
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
  controller?: ReadableStreamDefaultController<Uint8Array>;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  response(signal?: AbortSignal | null) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    signal?.addEventListener("abort", () => this.close(), { once: true });
    this.controller!.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "r1", runId: "r1" })}\n\n`),
    );
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
  emit(name: string, data: unknown) {
    if (this.controller && !this.closed) {
      const event = { type: "CUSTOM", name: "run", value: data };
      this.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller?.close();
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

test("foreground and SSE reconnect catch up a transcript that finished while detached", async (t) => {
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
    title: "Synthetic reconnect repro",
    type: "dm",
    createdAt: Date.now(),
  };
  const user: SessionEntry = { seq: 0, type: "user", createdAt: Date.now(), payload: { text: "Please answer" } };
  const caughtUp: SessionEntry[] = [
    user,
    { seq: 1, type: "assistant", createdAt: Date.now(), payload: { text: "Finished while you were away." } },
  ];
  let entries: SessionEntry[] = [user];
  let activeRun: { runId: string | null; run: { status: string } | null } = { runId: null, run: null };
  let transcriptCalls = 0;
  let transcriptFails = false;
  let intercept: ((path: string) => Promise<Response> | undefined) | undefined;
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requests.push(path);
    if (path.includes("/api/runs/") && path.includes("/events"))
      return new FakeEventSource(new URL(path, "http://localhost").pathname).response(init?.signal);
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
    if (path.includes("/api/runs/active")) return Response.json({ ...activeRun, queued: [] });
    if (path === "/api/turn") return Response.json({ runId: "r1" });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path.startsWith("/api/sessions/s1")) {
      transcriptCalls++;
      return transcriptFails
        ? Response.json({ error: "temporary synthetic outage" }, { status: 503 })
        : Response.json({ session: row, entries, earlierEntries: 0 });
    }
    if (path === "/api/sessions") return Response.json({ sessions: [row] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
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
    sessionsState.list = [row];
    sessionsState.loaded = true;
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    ensureDeliveryStream();
    const shown = (text: string) =>
      [...host.querySelectorAll(".assistant-body > .streaming-text, .work-said")].some((el) =>
        el.textContent?.includes(text),
      );
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
    conv.state.agent!.convertToLlm = () => [{ role: "user", content: "Please answer", timestamp: 0 }];
    await settle();
    requests.length = 0;
    transcriptCalls = 0;

    await t.test("a turn that ended while backgrounded is fetched on foreground return", async () => {
      entries = caughtUp;
      activeRun = { runId: null, run: null };
      assert.equal(shown("Finished while you were away."), false);
      conv!.resumeIfIdle();
      await until(() => transcriptCalls > 0);
      await settle();
      assert.ok(shown("Finished while you were away."), "terminal catch-up must refetch and render the reply");
    });

    await t.test("rapid repeated foreground triggers coalesce into a single rendered copy", async () => {
      transcriptCalls = 0;
      conv!.resumeIfIdle();
      conv!.resumeIfIdle();
      conv!.resumeIfIdle();
      await until(() => transcriptCalls > 0);
      await settle();
      const count = [...host.querySelectorAll(".assistant-body > .streaming-text, .work-said")].filter((el) =>
        el.textContent?.includes("Finished while you were away."),
      ).length;
      assert.equal(count, 1, "reconnect refetch must not duplicate an already-rendered reply");
    });

    await t.test("a still-running run is attached normally, not treated as a settled catch-up", async () => {
      const nextEntries: SessionEntry[] = [
        ...caughtUp,
        { seq: 2, type: "user", createdAt: Date.now(), payload: { text: "Next" } },
      ];
      entries = nextEntries;
      activeRun = { runId: "r2", run: { status: "running" } };
      intercept = (path) => {
        if (path === "/api/runs/r2/events")
          return Promise.resolve(new FakeEventSource("/api/runs/r2/events").response());
        return undefined;
      };
      const before = FakeEventSource.instances.length;
      conv!.resumeIfIdle();
      await until(() => FakeEventSource.instances.length > before);
      const run = FakeEventSource.instances.findLast((es) => es.url === "/api/runs/r2/events")!;
      run.onopen?.();
      assert.ok(
        FakeEventSource.instances.some((es) => es.url === "/api/runs/r2/events"),
        "an actually-active run must still be attached rather than only refetched",
      );
      activeRun = { runId: null, run: null };
      run.emit("done", { status: "done", result: { status: "silent", sessionId: row.id }, activity: [] });
      await until(() => conv!.state.agent!.state.isStreaming === false);
      await settle();
      intercept = undefined;
      entries = caughtUp;
    });

    await t.test("a failed catch-up refetch is retried on the next foreground trigger", async () => {
      entries = [
        ...caughtUp,
        { seq: 2, type: "assistant", createdAt: Date.now(), payload: { text: "Retried reply" } },
      ] as SessionEntry[];
      transcriptFails = true;
      transcriptCalls = 0;
      conv!.resumeIfIdle();
      await until(() => transcriptCalls > 0);
      await settle();
      assert.equal(shown("Retried reply"), false, "a failed refresh must not silently succeed");
      transcriptFails = false;
      transcriptCalls = 0;
      conv!.resumeIfIdle();
      await until(() => transcriptCalls > 0);
      await settle();
      assert.ok(shown("Retried reply"), "the next foreground trigger must retry and recover");
    });

    await t.test("a stale in-flight catch-up cannot overwrite a newer successful refresh", async () => {
      const stale: SessionEntry[] = [
        ...caughtUp,
        { seq: 2, type: "assistant", createdAt: Date.now(), payload: { text: "Stale" } },
      ];
      const fresh: SessionEntry[] = [
        ...caughtUp,
        { seq: 2, type: "assistant", createdAt: Date.now(), payload: { text: "Fresh" } },
      ];
      let release!: () => void;
      const pending = new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ session: row, entries: stale, earlierEntries: 0 }));
      });
      entries = stale;
      intercept = (path) => (path.startsWith("/api/sessions/s1") && !path.endsWith("/approvals") ? pending : undefined);
      conv!.resumeIfIdle();
      await until(() => requests.some((p) => p.startsWith("/api/sessions/s1")));
      intercept = undefined;
      entries = fresh;
      conv!.resumeIfIdle();
      await until(() => shown("Fresh"));
      release();
      await settle();
      assert.equal(shown("Stale"), false, "a slower stale response must be ignored once a newer refresh applied");
      assert.ok(shown("Fresh"));
      entries = caughtUp;
    });

    await t.test("a read-only viewer cannot trigger an authorized-transcript reconnect fetch", async () => {
      const ro = createConversation({
        pane: true,
        ownsUrl: false,
        container: () => host,
        claimContainer: () => host,
        visible: () => true,
        density: () => "full",
        onDensityChange() {},
        ensureDeliveryStream,
      }) as Conversation;
      ro.mountReadOnly(row as never, entriesToMessages(caughtUp, transcriptModel()));
      await settle();
      transcriptCalls = 0;
      ro.resumeIfIdle();
      await settle();
      assert.equal(transcriptCalls, 0, "read-only viewers have no live agent and must not fetch on resumeIfIdle");
      disposeConversation(ro);
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
