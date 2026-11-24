import { item } from "./item-fixture.ts";
import { metadata } from "./model-metadata.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { testViteServer } from "./vite-server.ts";
import type { Conversation } from "../src/conv-types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(check: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not settle`);
}

test("swarm worker read-only view streams live run activity, goal progress, swarm strip, and follow-up runs", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/",
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
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: undefined,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const startedAt = Date.now() - 2000;
  const row = {
    type: "dm" as const,
    createdAt: startedAt - 1000,
    id: "w1",
    threadRef: "swarm:root:worker1",
    scopeId: "personal:owner",
    title: "Swarm worker 79d954bf",
    canContinue: false,
    working: true,
    workingSince: startedAt,
  };
  const initialItems = [
    item("ToolCall", {
      seq: 1,
      createdAt: startedAt,
      tool: "execute",
      callId: "c1",
      body: { command: "echo hi", purpose: "Checking initial state" },
    }),
  ];
  let transcriptItems = initialItems;
  const run1Done = deferred<void>();
  const run2Done = deferred<void>();
  let phase: "run1" | "idle" | "run2" | "done" = "run1";
  const liveToolCall = item("ToolCall", {
    seq: 2,
    createdAt: startedAt + 500,
    tool: "execute",
    callId: "c2",
    body: { command: "ls -la", purpose: "Inspecting live worker output" },
  });
  const followUpToolCall = item("ToolCall", {
    seq: 4,
    createdAt: startedAt + 3000,
    tool: "execute",
    callId: "c3",
    body: { command: "echo next", purpose: "Running follow-up worker step" },
  });
  const activeGoal = {
    objective: "Verify all archival candidates",
    status: "active" as const,
    createdAt: startedAt,
    floor: "10m",
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.includes("runtime-config")) {
      return Response.json({
        scopeId: row.scopeId,
        models: ["gpt-5.6-sol"],
        modelCatalog: { "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol") },
        orgDefault: { modelId: "gpt-5.6-sol", revision: 0 },
        effective: { modelId: "gpt-5.6-sol" },
        scopeOverride: null,
      });
    }
    if (path.includes("/api/runs/active")) {
      if (phase === "run1") {
        return Response.json({
          runId: "r-live-1",
          run: {
            status: "running",
            startedAt,
            alive: true,
            goal: activeGoal,
            activity: [{ item: initialItems[0] }, { item: liveToolCall }],
            partial: "Streaming live findings from worker…",
          },
          queued: [],
        });
      }
      if (phase === "run2") {
        return Response.json({
          runId: "r-live-2",
          run: {
            status: "running",
            startedAt: Date.now(),
            alive: true,
            goal: activeGoal,
            activity: [{ item: followUpToolCall }],
          },
          queued: [],
        });
      }
      return Response.json({ runId: null, run: null, queued: [] });
    }
    if (path === "/api/runs/r-live-1/events" || path === "/api/runs/r-live-2/events") {
      return new Response(null, { status: 404 });
    }
    if (path === "/api/runs/r-live-1") {
      if (phase === "run1") await run1Done.promise;
      return Response.json({
        status: "done",
        startedAt,
        finishedAt: Date.now(),
        result: { status: "ok", reply: "First worker summary" },
      });
    }
    if (path === "/api/runs/r-live-2") {
      if (phase === "run2") await run2Done.promise;
      return Response.json({
        status: "done",
        startedAt,
        finishedAt: Date.now(),
        result: { status: "ok", reply: "Second worker summary" },
      });
    }
    if (path === "/api/sessions/w1/swarm") {
      return Response.json({
        id: "root-id",
        self: { id: "79d954bf-1111", parentId: "root-id", sessionId: "w1", state: "ready", depth: 1 },
        peers: [
          { id: "root-id", sessionId: "root-sess", sessionUrl: "/sessions/root-sess", state: "ready", depth: 0 },
          {
            id: "79d954bf-1111",
            parentId: "root-id",
            sessionId: "w1",
            sessionUrl: "/sessions/w1",
            state: "ready",
            depth: 1,
          },
        ],
      });
    }
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path.startsWith("/api/sessions/w1")) {
      return Response.json({ session: row, items: transcriptItems, earlierItems: 0, goal: activeGoal });
    }
    if (path.startsWith("/api/sessions?")) return Response.json({ sessions: [row] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await testViteServer();
  let conv: Conversation | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { itemsToMessages } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    seedRuntimeConfig(row.scopeId, await (await fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = [row];
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    conv = createConversation({
      pane: true,
      ownsUrl: false,
      container: () => host,
      claimContainer: () => host,
      visible: () => true,
      density: () => "full",
      onDensityChange() {},
      ensureDeliveryStream() {},
    }) as Conversation;

    conv.mountReadOnly(row, itemsToMessages(initialItems, transcriptModel()));
    conv.setGoal(activeGoal);

    await until(
      () =>
        (host.textContent ?? "").includes("Inspecting live worker output") &&
        (host.textContent ?? "").includes("Streaming live findings from worker"),
      "live worker streaming",
    );
    assert.equal(host.querySelector("textarea"), null, "read-only worker view must not show a composer");
    assert.equal(host.querySelector(".fork-btn"), null, "read-only worker view must not show fork buttons");

    const goalEl = host.querySelector(".goal-strip");
    assert.ok(goalEl, "read-only worker view should render the active goal strip");
    assert.match(goalEl.textContent ?? "", /Verify all archival candidates/);
    assert.equal(goalEl.querySelector("button"), null, "read-only goal strip should not render action buttons");

    await until(() => Boolean(host.querySelector(".swarm-activity")), "swarm strip");

    phase = "idle";
    transcriptItems = [
      ...initialItems,
      liveToolCall,
      item("AgentMessage", { seq: 3, createdAt: Date.now(), text: "First worker summary" }),
    ];
    run1Done.resolve();
    await until(() => (host.textContent ?? "").includes("First worker summary"), "first worker summary");
    await until(() => !conv?.state.agent?.state.isStreaming, "idle after first run");

    phase = "run2";
    conv.resumeIfIdle();
    await until(() => (host.textContent ?? "").includes("Running follow-up worker step"), "follow-up live run");

    phase = "done";
    transcriptItems = [
      ...transcriptItems,
      followUpToolCall,
      item("AgentMessage", { seq: 5, createdAt: Date.now(), text: "Second worker summary" }),
    ];
    run2Done.resolve();
    await until(() => (host.textContent ?? "").includes("Second worker summary"), "second worker summary");
  } finally {
    run1Done.resolve();
    run2Done.resolve();
    conv?.state.agent?.abort();
    await conv?.state.agent?.waitForIdle();
    conv?.composer.dispose();
    conv?.dispose();
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
