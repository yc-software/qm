import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("a steered queued message stays visible as Steering until model intake or the run ends", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
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
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async () => Response.json({ sessions: [] }),
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
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
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
    seedRuntimeConfig("personal:tester", {
      scopeId: "personal:tester",
      approvedHarnesses: ["pi"],
      modelsByHarness: { pi: ["alpha"] },
      modelCatalog: { alpha: model },
      orgDefault: { harnessId: "pi", modelId: "alpha", revision: 1 },
      effective: { harnessId: "pi", modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const threadRef = "web:tester:steering";
    const host = document.querySelector<HTMLElement>("#composer")!;
    const agentState = { isStreaming: true, model, messages: [] as unknown[] };
    const agent = { state: agentState } as unknown as Agent;
    let live = true;
    const signalled: string[] = [];
    const draw = (): void => render(composer!.queuedStrip(agent), host);
    const ctx = {
      pane: false,
      chat: {
        state: { agent, host, threadRef, sessionId: "s", scopeId: "personal:tester" },
        isStopping: () => false,
        hasLiveRun: () => live,
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
    const chips = () =>
      [...host.querySelectorAll(".queued-chip")].map((chip) => ({
        tag: chip.querySelector(".queued-tag")?.textContent?.trim(),
        text: chip.querySelector(".queued-text")?.textContent?.trim(),
      }));
    const steer = async (runId: string): Promise<void> => {
      composer!.setQueuedRuns(threadRef, [{ runId, text: "same text" }]);
      draw();
      host.querySelector<HTMLButtonElement>(".queued-steer")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(signalled.includes(runId));
      draw();
    };
    const intake = (runId: string, entrySeq: number): void => {
      agentState.messages.push({
        role: "user",
        content: "same text",
        steered: true,
        entrySeq,
        ts: `queued-steer:${threadRef}:${runId}`,
      });
    };

    await t.test("accepting a steer keeps the chip and fabricates no transcript message", async () => {
      await steer("q1");
      assert.deepEqual(composer!.queuedRunsFor(threadRef), []);
      assert.deepEqual(chips(), [{ tag: "Steering", text: "same text" }]);
      assert.equal(agentState.messages.length, 0);
    });

    await t.test("repeated text settles only the steer whose intake ts arrived", async () => {
      await steer("q2");
      assert.deepEqual(chips(), [
        { tag: "Steering", text: "same text" },
        { tag: "Steering", text: "same text" },
      ]);
      intake("q2", 4);
      draw();
      assert.deepEqual(chips(), [{ tag: "Steering", text: "same text" }]);
      intake("q1", 5);
      draw();
      assert.deepEqual(chips(), []);
    });

    await t.test("an unrelated steered message with the same text does not settle the chip", async () => {
      await steer("q3");
      agentState.messages.push({ role: "user", content: "same text", steered: true, entrySeq: 6, ts: "other" });
      draw();
      assert.deepEqual(chips(), [{ tag: "Steering", text: "same text" }]);
    });

    await t.test("the chip goes when the run ends without intake", async () => {
      agentState.isStreaming = false;
      live = false;
      draw();
      assert.deepEqual(chips(), []);
      agentState.isStreaming = true;
      live = true;
      draw();
      assert.deepEqual(chips(), []);
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
