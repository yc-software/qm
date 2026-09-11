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

test("post replies remain visible in new and continuing conversations", async (t) => {
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
    const shown = (text: string) =>
      [...host.querySelectorAll(".assistant-body > .streaming-text, .work-said")].some((el) =>
        el.textContent?.includes(text),
      );
    async function postTurn(index: number, fails = false) {
      const text = `Confirmed answer ${index}`;
      const seq = index * 3;
      const activity: SessionEntry[] = [
        {
          seq: seq + 1,
          type: "tool_call",
          createdAt: Date.now(),
          payload: { tool: "web", action: "post", text, callId: `post-${index}` },
        },
        {
          seq: seq + 2,
          type: "tool_result",
          createdAt: Date.now(),
          payload: { tool: "web", callId: `post-${index}`, isError: false, ok: true, result: "[sent]" },
        },
      ];
      const before = FakeEventSource.instances.length;
      const turn = conv!.state.agent!.prompt(`Question ${index}`);
      await until(() => FakeEventSource.instances.length > before);
      const run = FakeEventSource.instances.findLast((es) => es.url === "/api/runs/r1/events")!;
      run.onopen?.();
      entries = [
        ...entries,
        { seq, type: "user", createdAt: Date.now(), payload: { text: `Question ${index}` } },
        ...activity,
      ];
      transcriptFails = fails;
      run.emit("done", { status: "done", result: { status: "silent", sessionId: row.id }, activity });
      await turn;
      await settle();
      return text;
    }
    await t.test("control: reopening displays a persisted post", async () => {
      await mount(completed);
      assert.ok(shownAnswer());
    });
    await t.test("a new session accepts every transcript after adoption without fork metadata", async () => {
      await mount();
      conv!.mountContinuable(row.threadRef, null, row.scopeId, []);
      conv!.state.agent!.convertToLlm = () => [{ role: "user", content: "Please answer", timestamp: 0 }];
      entries = [];
      const visible: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        const text = await postTurn(i);
        assert.equal(conv!.state.sessionId, row.id);
        visible.push(shown(text));
      }
      assert.deepEqual(
        visible,
        [true, true, true],
        "repeated posts must not stay hidden for the life of a new session",
      );
      assert.equal(conv!.state.forkSession, null);
      const messages = conv!.state.agent!.state.messages;
      assert.ok(messages.some((m) => JSON.stringify(m).includes("Confirmed answer 2")));
      assert.equal(conv!.state.transcriptAnchorSeq, null);
      assert.ok(
        messages.some(
          (m) =>
            m.role === "assistant" &&
            JSON.stringify((m as { content?: unknown }).content).includes("Confirmed answer 2"),
        ),
        "the durable transcript must actually apply, not just the activity fallback",
      );
    });
    await t.test("confirmed posts remain visible over consecutive failed transcript refreshes", async () => {
      await mount();
      const visible: boolean[] = [];
      for (let i = 0; i < 3; i++) visible.push(shown(await postTurn(i, true)));
      assert.deepEqual(visible, [true, true, true]);
      transcriptFails = false;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await settle();
      for (let i = 0; i < 3; i++) {
        assert.equal(
          [...host.querySelectorAll(".assistant-body > .streaming-text, .work-said")].filter((el) =>
            el.textContent?.includes(`Confirmed answer ${i}`),
          ).length,
          1,
          "refresh must not duplicate a displayed post",
        );
      }
    });
    function deferredTranscript(recorded: SessionEntry[]) {
      let release!: () => void;
      const promise = new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ session: row, entries: recorded, earlierEntries: 0 }));
      });
      return { promise, release };
    }
    await t.test("a late transcript cannot replace a newer successful refresh", async () => {
      await mount();
      const pending = deferredTranscript([user]);
      intercept = (path) =>
        path.startsWith("/api/sessions/s1") && !path.endsWith("/approvals") ? pending.promise : undefined;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await until(() => requests.some((path) => path.startsWith("/api/sessions/s1")));
      intercept = undefined;
      entries = completed;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await settle();
      assert.ok(shownAnswer());
      pending.release();
      await settle();
      assert.ok(shownAnswer());
    });
    await t.test("a transcript started before teardown cannot write into the replacement chat", async () => {
      await mount();
      const oldAgent = conv!.state.agent;
      const pending = deferredTranscript(completed);
      intercept = (path) =>
        path.startsWith("/api/sessions/s1") && !path.endsWith("/approvals") ? pending.promise : undefined;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await until(() => requests.some((path) => path.startsWith("/api/sessions/s1")));
      intercept = undefined;
      conv!.mountContinuable("web:owner:replacement", null, row.scopeId, []);
      pending.release();
      await settle();
      assert.notEqual(conv!.state.agent, oldAgent);
      assert.equal(shownAnswer(), false);
      assert.equal(conv!.state.threadRef, "web:owner:replacement");
    });
    await t.test("fork history follows the same refresh generation and preserves fully loaded history", async () => {
      await mount();
      conv!.state.forkSession = { ...row, forkedFrom: { sessionId: "source" }, forkBoundarySeq: 0 } as never;
      conv!.state.inheritedLoaded = false;
      const pending = deferredTranscript([{ ...user, payload: { text: "Stale inherited text" } }]);
      intercept = (path) =>
        path.startsWith("/api/sessions/s1") && !path.endsWith("/approvals") ? pending.promise : undefined;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await until(() => requests.some((path) => path.startsWith("/api/sessions/s1")));
      intercept = undefined;
      entries = [{ ...user, payload: { text: "Current inherited text" } }, ...completed.slice(1)];
      delivery.emit("delivery", { threadRef: row.threadRef });
      await settle();
      const inherited = JSON.stringify(conv!.state.inheritedMessages);
      assert.match(inherited, /Current inherited text/);
      pending.release();
      await settle();
      assert.equal(JSON.stringify(conv!.state.inheritedMessages), inherited);
      conv!.state.inheritedLoaded = true;
      entries = completed;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await settle();
      assert.equal(JSON.stringify(conv!.state.inheritedMessages), inherited);
    });
    await t.test("navigation during approval loading cannot update the replacement chat", async () => {
      await mount();
      let release!: () => void;
      const promise = new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ approvals: [] }));
      });
      entries = completed;
      intercept = (path) => (path.endsWith("/approvals") ? promise : undefined);
      delivery.emit("delivery", { threadRef: row.threadRef });
      await until(() => requests.some((path) => path.endsWith("/approvals")));
      conv!.mountContinuable("web:owner:replacement", null, row.scopeId, []);
      release();
      intercept = undefined;
      await settle();
      assert.equal(shownAnswer(), false);
      assert.deepEqual(conv!.state.agent!.state.messages, []);
    });
    await t.test("multiple posts in one turn appear once before and after transcript recovery", async () => {
      await mount();
      const activity: SessionEntry[] = [
        ...completed.slice(1, 3),
        {
          seq: 3,
          type: "tool_call",
          createdAt: Date.now(),
          payload: { tool: "web", action: "post", text: "Second confirmed reply", callId: "c2" },
        },
        {
          seq: 4,
          type: "tool_result",
          createdAt: Date.now(),
          payload: { tool: "web", callId: "c2", isError: false, result: "[sent]" },
        },
      ];
      const before = FakeEventSource.instances.length;
      const turn = conv!.state.agent!.prompt("Send two replies");
      await until(() => FakeEventSource.instances.length > before);
      const run = FakeEventSource.instances.findLast((es) => es.url === "/api/runs/r1/events")!;
      run.onopen?.();
      transcriptFails = true;
      run.emit("done", { status: "done", result: { status: "silent", sessionId: row.id }, activity });
      await turn;
      await settle();
      const count = (text: string) =>
        [...host.querySelectorAll(".assistant-body > .streaming-text, .work-said")].filter((el) =>
          el.textContent?.includes(text),
        ).length;
      assert.equal(count(answer), 1);
      assert.equal(count("Second confirmed reply"), 1);
      entries = [
        user,
        ...activity,
        { seq: 5, type: "assistant", createdAt: Date.now(), payload: { text: "Replies sent." } },
      ];
      transcriptFails = false;
      delivery.emit("delivery", { threadRef: row.threadRef });
      await settle();
      assert.equal(count(answer), 1);
      assert.equal(count("Second confirmed reply"), 1);
      assert.equal(count("Replies sent."), 0);
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
