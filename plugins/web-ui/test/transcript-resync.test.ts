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

test("open conversations recover persisted replies after missed delivery notifications", async (t) => {
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
    title: "Synthetic reply repro",
    type: "dm",
    createdAt: Date.now(),
  };
  const user: SessionEntry = { seq: 0, type: "user", createdAt: Date.now(), payload: { text: "Please answer" } };
  const answer = "The durable reply is present in storage.";
  const completed: SessionEntry[] = [
    user,
    {
      seq: 1,
      type: "tool_call",
      createdAt: Date.now(),
      payload: { tool: "web", action: "post", text: answer, callId: "c1" },
    },
    {
      seq: 2,
      parentSeq: 1,
      type: "tool_result",
      createdAt: Date.now(),
      payload: { tool: "web", action: "post", ok: true, callId: "c1", result: "[sent]" },
    },
    { seq: 3, type: "assistant", createdAt: Date.now(), payload: { text: "Replied in thread." } },
  ];
  let entries = [user];
  let transcriptFails = false;
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
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path === "/api/turn") return Response.json({ runId: "r1" });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path.startsWith("/api/sessions/s1"))
      return transcriptFails
        ? Response.json({ error: "temporary synthetic outage" }, { status: 503 })
        : Response.json({ session: row, entries, earlierEntries: 0 });
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
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/composer.ts");
    seedRuntimeConfig(row.scopeId, await (await fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = [row];
    sessionsState.loaded = true;
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    ensureDeliveryStream();
    const delivery = FakeEventSource.instances.find((es) => es.url === "/api/deliveries/events")!;
    const shownAnswer = () =>
      [...host.querySelectorAll(".assistant-body > .streaming-text")].some((el) => el.textContent?.includes(answer));
    async function mount(recorded: SessionEntry[] = [user], readOnly = false, wait = true) {
      if (conv) disposeConversation(conv);
      entries = recorded;
      transcriptFails = false;
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
      if (readOnly) conv.mountReadOnly(row as never, entriesToMessages(recorded, transcriptModel()));
      else {
        conv.mountContinuable(
          row.threadRef,
          row.id,
          row.scopeId,
          entriesToMessages(recorded, transcriptModel()),
          null,
          row as never,
        );
        conv.state.agent!.convertToLlm = () => [{ role: "user", content: "Please answer", timestamp: 0 }];
      }
      if (wait) await settle();
      requests.length = 0;
    }
    await t.test("control: reopening the conversation displays the already persisted post", async () => {
      await mount(completed);
      assert.ok(shownAnswer());
    });
    await t.test("first event-stream open fills the gap since the initial transcript fetch", async () => {
      await mount();
      entries = completed;
      delivery.onopen?.();
      await settle();
      assert.ok(shownAnswer(), `missing reply after initial open; requests=${JSON.stringify(requests)}`);
    });
    await t.test("browser event-stream reconnect reloads the transcript, not only the sidebar", async () => {
      await mount();
      entries = completed;
      delivery.onopen?.();
      await settle();
      assert.ok(shownAnswer(), `missing reply after reconnect; requests=${JSON.stringify(requests)}`);
    });
    await t.test("server resync frame reconciles an open conversation", async () => {
      await mount();
      entries = completed;
      delivery.emit("session_state_resync", {});
      await settle();
      assert.ok(shownAnswer(), `missing reply after server resync; requests=${JSON.stringify(requests)}`);
    });
    await t.test("returning to a tab after the run has finished reloads its transcript", async () => {
      await mount();
      entries = completed;
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      assert.ok(shownAnswer(), `missing reply after tab return; requests=${JSON.stringify(requests)}`);
    });
    await t.test("idle session-state event reconciles a missed delivery", async () => {
      await mount();
      entries = completed;
      delivery.emit("session_state", { threadRef: row.threadRef, sessionId: row.id, state: "idle", at: Date.now() });
      await settle();
      assert.ok(shownAnswer(), `missing reply after idle event; requests=${JSON.stringify(requests)}`);
    });
    await t.test("control: a normal delivery notification reloads the transcript", async () => {
      await mount();
      entries = completed;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await settle();
      assert.ok(
        shownAnswer(),
        `normal delivery failed; requests=${JSON.stringify(requests)}, state=${JSON.stringify(conv!.state.agent!.state.messages)}`,
      );
    });
    await t.test("read-only conversations also recover after a reconnect", async () => {
      await mount([user], true);
      entries = completed;
      delivery.onopen?.();
      await settle();
      assert.ok(shownAnswer(), `missing readonly reply after reconnect; requests=${JSON.stringify(requests)}`);
    });
    await t.test("a brand-new chat displays its persisted post after adopting its session id", async () => {
      await mount();
      conv!.mountContinuable(row.threadRef, null, row.scopeId, []);
      conv!.state.agent!.convertToLlm = () => [{ role: "user", content: "Please answer", timestamp: 0 }];
      const agent = conv!.state.agent!;
      const before = FakeEventSource.instances.length;
      const turn = agent.prompt("Please answer");
      await until(() => FakeEventSource.instances.length > before);
      const run = FakeEventSource.instances.findLast((es) => es.url === "/api/runs/r1/events")!;
      run.onopen?.();
      entries = completed;
      delivery.emit("delivery", { threadRef: row.threadRef });
      run.emit("done", {
        status: "done",
        result: { status: "ok", reply: "Replied in thread." },
        activity: completed.slice(1, 3),
      });
      await turn;
      await settle();
      assert.equal(conv!.state.sessionId, row.id, "the newly created session was adopted");
      assert.ok(
        shownAnswer(),
        `new-chat post lost despite successful transcript read; forkSession=${JSON.stringify(conv!.state.forkSession)}, requests=${JSON.stringify(requests)}`,
      );
    });
    await t.test("failed completion refresh recovers on reconnect without rerunning the task", async () => {
      await mount();
      const agent = conv!.state.agent!;
      const before = FakeEventSource.instances.length;
      const turn = agent.continue();
      await until(() => FakeEventSource.instances.length > before);
      const run = FakeEventSource.instances.findLast((es) => es.url === "/api/runs/r1/events")!;
      run.onopen?.();
      entries = completed;
      delivery.emit("delivery", { threadRef: row.threadRef });
      transcriptFails = true;
      run.emit("done", {
        status: "done",
        result: { status: "ok", reply: "Replied in thread." },
        activity: completed.slice(1, 3),
      });
      await turn;
      await settle();
      assert.equal(
        shownAnswer(),
        false,
        "the failed refresh leaves the sent post as activity rather than an answer bubble",
      );
      transcriptFails = false;
      requests.length = 0;
      delivery.onopen?.();
      await settle();
      assert.ok(shownAnswer(), `missing persisted reply after recovery; requests=${JSON.stringify(requests)}`);
      assert.ok(!requests.includes("/api/turn"), "recovery must not submit the task a second time");
    });
    function deferredTranscript(recorded: SessionEntry[]) {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((r) => {
        resolve = r;
      });
      return { promise, release: () => resolve(Response.json({ session: row, entries: recorded, earlierEntries: 0 })) };
    }
    const runSources = () => FakeEventSource.instances.filter((es) => es.url === "/api/runs/race-run/events");
    await t.test("initial SSE open must not race mount-time resume and hide its triggering message", async () => {
      const trigger = "External trigger persisted before resume";
      const liveEntries: SessionEntry[] = [
        user,
        { seq: 1, type: "assistant", createdAt: Date.now(), payload: { text: "Earlier reply" } },
        { seq: 2, type: "user", createdAt: Date.now(), payload: { text: trigger } },
      ];
      const held: ReturnType<typeof deferredTranscript>[] = [];
      let liveRun = true;
      intercept = (path) => {
        if (path.includes("/api/runs/active"))
          return Promise.resolve(
            Response.json(
              liveRun
                ? { runId: "race-run", run: { status: "running", result: null, activity: [] }, queued: [] }
                : { runId: null, queued: [] },
            ),
          );
        if (path.startsWith("/api/sessions/s1") && !path.endsWith("/approvals") && liveRun) {
          const d = deferredTranscript(liveEntries);
          held.push(d);
          return d.promise;
        }
      };
      await mount([user], false, false);
      entries = liveEntries;
      delivery.onopen?.();
      await until(() => held.length >= 1);
      await settle();
      held[0]!.release();
      await until(() => runSources().length >= 1);
      const run = runSources().at(-1)!;
      run.onopen?.();
      for (const d of held.slice(1)) d.release();
      await settle();
      const triggerShown = host.textContent!.includes(trigger);
      const count = runSources().length;
      liveRun = false;
      run.emit("done", { status: "done", result: { status: "ok", reply: "Completed" } });
      await conv!.state.agent!.waitForIdle();
      await settle();
      intercept = undefined;
      assert.equal(count, 1, "open/reconnect must not duplicate run streams");
      assert.ok(triggerShown, "the live stream must include the user message it is answering");
    });
    await t.test("a slow read-only reconnect must not erase a later delivered reply", async () => {
      await mount([user], true);
      const held: ReturnType<typeof deferredTranscript>[] = [];
      let hold = true;
      intercept = (path) => {
        if (path.startsWith("/api/sessions/s1") && !path.endsWith("/approvals") && hold) {
          const d = deferredTranscript([user]);
          held.push(d);
          return d.promise;
        }
      };
      delivery.onopen?.();
      await settle();
      hold = false;
      entries = completed;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await until(shownAnswer);
      for (const d of held) d.release();
      await settle();
      const afterLateResponse = shownAnswer();
      intercept = undefined;
      assert.ok(
        afterLateResponse,
        "reconnect's older snapshot must not overwrite a reply already rendered by delivery",
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
