import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { testViteServer } from "./vite-server.ts";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("a mid-run send with the steer preference asks core to steer and queues only when core says so", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  let turnId = 0;
  const turns: Array<{ text: string; midTurn: string }> = [];
  let coreSteers = true;
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/turn")) {
        const body = JSON.parse(String(init?.body)) as { text: string; midTurn: string };
        turns.push({ text: body.text, midTurn: body.midTurn });
        if (body.midTurn === "steer" && coreSteers)
          return Response.json({ status: "queued", runId: "live", steered: true, steerTs: `ts${++turnId}` });
        return Response.json({ status: "queued", runId: `q${++turnId}` });
      }
      if (url.includes("/api/ui-state")) return Response.json({ ok: true, updatedAt: 1 });
      return Response.json({ sessions: [] });
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await testViteServer();
  let composer: ComposerSurface | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { seedRuntimeConfig, invalidateRuntimeConfigs } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    const { setAlwaysSteer } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test" };
    const model = {
      id: "alpha",
      name: "Alpha",
      label: "Alpha",
      buttonLabel: "Alpha",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    };
    invalidateRuntimeConfigs();
    seedRuntimeConfig("personal:tester", {
      scopeId: "personal:tester",
      models: ["alpha"],
      modelCatalog: { alpha: model },
      orgDefault: { modelId: "alpha", revision: 1 },
      effective: { modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const threadRef = "web:tester:always-steer";
    const host = document.querySelector<HTMLElement>("#composer")!;
    const agentState = { isStreaming: true, model, messages: [] as unknown[] };
    const agent = { state: agentState } as unknown as Agent;
    let live = true;
    const signalled: string[] = [];
    const seenTags = new Set<string>();
    const chips = () =>
      [...host.querySelectorAll(".queued-chip")].map((chip) => chip.querySelector(".queued-tag")?.textContent?.trim());
    const draw = (): void => {
      render(composer!.queuedStrip(agent), host);
      for (const tag of chips()) if (tag) seenTags.add(tag);
    };
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef,
          sessionId: "s",
          scopeId: "personal:tester",
          resolvingApprovals: new Set(),
        },
        isStopping: () => false,
        hasLiveRun: () => live,
        hasUnresolvedApproval: () => false,
        activePendingApprovals: () => [],
        turnRuntime: () => null,
        notePendingSessionOnSend() {},
        scrollToBottom() {},
        currentTurnOptions: () => ({}),
        signalLiveRun: async (_kind: string, _text: string, queuedRunId: string) => {
          signalled.push(queuedRunId);
          return { ok: true };
        },
        drawActiveChat: draw,
        resumeIfIdle() {},
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    const send = async (text: string): Promise<void> => {
      seenTags.clear();
      composer!.state.draft = text;
      await composer!.submit();
      await new Promise((resolve) => setTimeout(resolve, 10));
      draw();
    };
    const reset = (): void => {
      composer!.setQueuedRuns(threadRef, []);
      agentState.isStreaming = false;
      live = false;
      draw();
      agentState.isStreaming = true;
      live = true;
      coreSteers = true;
      signalled.length = 0;
    };

    await t.test("with the preference off a mid-run send still queues", async () => {
      await send("first");
      assert.deepEqual(turns.at(-1), { text: "first", midTurn: "queue" });
      assert.deepEqual(chips(), ["Queued"]);
      reset();
    });

    await t.test("with the preference on a mid-run send is one steer request and never shows as queued", async () => {
      setAlwaysSteer(true);
      await send("second");
      assert.deepEqual(turns.at(-1), { text: "second", midTurn: "steer" });
      assert.deepEqual(signalled, []);
      assert.deepEqual(composer!.queuedRunsFor(threadRef), []);
      assert.deepEqual(chips(), []);
      assert.deepEqual(
        composer!.waitingSteers(agent).map((q) => q.text),
        ["second"],
      );
      assert.equal(seenTags.has("Queued"), false);
      reset();
    });

    const cmdEnter = async (text: string): Promise<void> => {
      const formHost = document.createElement("div");
      document.body.append(formHost);
      composer!.state.draft = text;
      render(composer!.composerForm(agent), formHost);
      formHost
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      formHost.remove();
      draw();
    };

    await t.test("Cmd+Enter sends the opposite of the preference", async () => {
      setAlwaysSteer(false);
      await cmdEnter("flip to steer");
      assert.deepEqual(turns.at(-1), { text: "flip to steer", midTurn: "steer" });
      reset();
      setAlwaysSteer(true);
      await cmdEnter("flip to queue");
      assert.deepEqual(turns.at(-1), { text: "flip to queue", midTurn: "queue" });
      assert.deepEqual(chips(), ["Queued"]);
      reset();
    });

    await t.test("holding Cmd flips the send button to the other action", async () => {
      setAlwaysSteer(false);
      const formHost = document.createElement("div");
      document.body.append(formHost);
      const label = (): string | null => {
        render(composer!.composerForm(agent), formHost);
        return formHost.querySelector(".send-btn")!.getAttribute("aria-label");
      };
      assert.match(label()!, /^Queue for after this turn \(/);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
      assert.equal(label(), "Steer the running task");
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
      assert.match(label()!, /^Queue for after this turn \(/);
      formHost.remove();
      setAlwaysSteer(true);
    });

    await t.test("a run that has no live handle asks core to queue", async () => {
      live = false;
      await send("fourth");
      assert.deepEqual(turns.at(-1), { text: "fourth", midTurn: "queue" });
      assert.deepEqual(chips(), ["Queued"]);
      reset();
    });

    await t.test("a steer core runs as its own turn lands in the queue instead of vanishing", async () => {
      coreSteers = false;
      await send("fifth");
      assert.deepEqual(turns.at(-1), { text: "fifth", midTurn: "steer" });
      assert.deepEqual(composer!.queuedRunsFor(threadRef), [{ runId: `q${turnId}`, text: "fifth" }]);
      reset();
    });
  } finally {
    composer?.dispose?.();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
