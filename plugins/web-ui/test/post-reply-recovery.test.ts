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
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
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
    const shownReplies = (text: string) => {
      const matches = [...host.querySelectorAll(".assistant-body > .streaming-text, .work-message")].filter((el) =>
        el.textContent?.includes(text),
      );
      for (const match of matches)
        assert.equal(
          match.closest("details:not([open])"),
          null,
          "delivered replies must remain visible outside closed work",
        );
      return matches;
    };
    const shown = (text: string) => shownReplies(text).length > 0;
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
      run.emit("run", { status: "running", result: null, activity });
      await settle();
      assert.equal(shownReplies(text).length, 1, "a confirmed post is visible while the turn continues");
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
        assert.equal(shownReplies(`Confirmed answer ${i}`).length, 1, "refresh must not duplicate a displayed post");
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
      run.emit("run", { status: "running", result: null, activity });
      await settle();
      assert.deepEqual(
        shownReplies(answer).map((el) => el.textContent?.trim()),
        [answer],
      );
      assert.deepEqual(
        shownReplies("Second confirmed reply").map((el) => el.textContent?.trim()),
        ["Second confirmed reply"],
      );
      run.emit("done", { status: "done", result: { status: "silent", sessionId: row.id }, activity });
      await turn;
      await settle();
      const count = (text: string) => shownReplies(text).length;
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
    for (const edited of [false, true]) {
      await t.test(
        `delayed ended-run steer ${edited ? "preserves a newer draft" : "resends after completion"}`,
        async (sub) => {
          sub.after(() => {
            intercept = undefined;
          });
          await mount();
          const agent = conv!.state.agent!;
          let oldRunLive = true;
          let signalled = false;
          let resends = 0;
          intercept = (path) => {
            if (path.includes("/api/runs/active"))
              return Promise.resolve(
                Response.json({
                  runId: oldRunLive ? "r1" : null,
                  run: oldRunLive ? { status: "running" } : null,
                  queued: [],
                }),
              );
            if (path === "/api/runs/queued/withdraw") return Promise.resolve(Response.json({ withdrawn: true }));
            if (path === "/api/runs/r1/signal") {
              signalled = true;
              return Promise.resolve(Response.json({ reason: "terminal", replayed: false }, { status: 409 }));
            }
            if (path === "/api/turn") {
              resends++;
              return Promise.resolve(Response.json({ reply: "Follow-up received" }));
            }
          };
          const before = FakeEventSource.instances.length;
          conv!.resumeIfIdle();
          await until(() => FakeEventSource.instances.length > before);
          const turn = agent.waitForIdle();
          const run = FakeEventSource.instances.findLast((es) => es.url === "/api/runs/r1/events")!;
          run.onopen?.();
          conv!.composer.setQueuedRuns(row.threadRef, [{ runId: "queued", text: "Follow-up question" }]);
          conv!.drawActiveChat(agent);
          host.querySelector<HTMLButtonElement>(".queued-steer")!.click();
          await until(() => signalled && conv!.composer.state.draft === "Follow-up question");
          if (edited) conv!.composer.state.draft = "New draft";
          await new Promise((resolve) => setTimeout(resolve, 5_200));
          assert.equal(resends, 0);
          oldRunLive = false;
          run.emit("done", { status: "done", result: { status: "ok", reply: "Original answer" } });
          await turn;
          if (!edited) await until(() => resends === 1);
          await settle();
          assert.equal(resends, edited ? 0 : 1);
          if (edited) assert.equal(conv!.composer.state.draft, "New draft");
          intercept = undefined;
        },
      );
    }
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
