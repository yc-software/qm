import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("a mid-run send with the steer preference steers at once and queues only when it cannot", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  let turnId = 0;
  const turns: string[] = [];
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
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/turn")) {
        turns.push(JSON.parse(String(init?.body)).text);
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
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
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
    const seed = (harness: string): void => {
      invalidateRuntimeConfigs();
      seedRuntimeConfig("personal:tester", {
        scopeId: "personal:tester",
        approvedHarnesses: [harness],
        modelsByHarness: { [harness]: ["alpha"] },
        modelCatalog: { alpha: model },
        orgDefault: { harnessId: harness, modelId: "alpha", revision: 1 },
        effective: { harnessId: harness, modelId: "alpha" },
        scopeOverride: null,
        upgradeAvailable: false,
      });
    };
    seed("pi");
    const threadRef = "web:tester:always-steer";
    const host = document.querySelector<HTMLElement>("#composer")!;
    const agentState = { isStreaming: true, model, messages: [] as unknown[] };
    const agent = { state: agentState } as unknown as Agent;
    let live = true;
    let outcome: Record<string, unknown> = { ok: true };
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
        currentTurnOptions: () => ({}),
        signalLiveRun: async (_kind: string, _text: string, queuedRunId: string) => {
          signalled.push(queuedRunId);
          return outcome;
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
      outcome = { ok: true };
      signalled.length = 0;
    };

    await t.test("with the preference off a mid-run send still queues", async () => {
      await send("first");
      assert.deepEqual(signalled, []);
      assert.deepEqual(chips(), ["Queued"]);
      reset();
    });

    await t.test("with the preference on a mid-run send steers without ever showing as queued", async () => {
      setAlwaysSteer(true);
      await send("second");
      assert.equal(turns.at(-1), "second");
      assert.deepEqual(signalled, [`q${turnId}`]);
      assert.deepEqual(composer!.queuedRunsFor(threadRef), []);
      assert.deepEqual(chips(), ["Steering"]);
      assert.equal(seenTags.has("Queued"), false);
      reset();
    });

    await t.test("a harness that cannot steer falls back to the queue", async () => {
      seed("codex");
      ctx.chat.state.threadRef = "web:tester:codex-thread";
      assert.equal(composer!.currentModelOption()?.harnessId, "codex");
      try {
        await send("third");
        assert.deepEqual(signalled, []);
        assert.deepEqual(chips(), ["Queued"]);
      } finally {
        seed("pi");
        composer!.setQueuedRuns(ctx.chat.state.threadRef!, []);
        ctx.chat.state.threadRef = threadRef;
        reset();
      }
    });

    await t.test("a run that has no live handle falls back to the queue", async () => {
      live = false;
      await send("fourth");
      assert.deepEqual(signalled, []);
      assert.deepEqual(chips(), ["Queued"]);
      reset();
    });

    await t.test("a steer the run refuses lands in the queue instead of vanishing", async () => {
      outcome = { ok: false, reason: "terminal" };
      await send("fifth");
      assert.deepEqual(signalled, [`q${turnId}`]);
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
