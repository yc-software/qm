import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";
import type { RuntimeConfig } from "../src/core-bridge.ts";
import { metadata } from "./model-metadata.ts";

test("a reopened session keeps its runtime in the picker and sends its next turn on it", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/web-ui/s/reopened",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const config: RuntimeConfig = {
    scopeId: "personal:tester",
    approvedHarnesses: ["pi", "claude"],
    modelsByHarness: { pi: ["opus", "sonnet"], claude: ["opus"] },
    modelCatalog: {
      opus: { ...metadata("opus", "Opus 5", "anthropic"), reasoning: true },
      sonnet: { ...metadata("sonnet", "Sonnet 5.5", "anthropic"), reasoning: true },
    },
    orgDefault: { harnessId: "pi", modelId: "opus", effortLevel: "low", revision: 1 },
    effective: { harnessId: "pi", modelId: "opus", effortLevel: "low" },
    scopeOverride: null,
    upgradeAvailable: false,
  };
  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => (releaseConfig = resolve));
  const turns: Array<Record<string, unknown>> = [];
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
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/runtime-config")) {
        await configGate;
        return Response.json(config);
      }
      if (url.endsWith("/api/turn") && init?.method === "POST") {
        turns.push(JSON.parse(String(init.body)));
        return Response.json({ status: "ok", text: "done" });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  localStorage.setItem("web-ui:loadout", JSON.stringify([{ value: "pi:sonnet", effort: "low", fast: false }]));
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let composer: ComposerSurface | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { makeCoreStreamFn } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test" };
    const host = document.querySelector<HTMLElement>("#composer")!;
    const agent = { state: { isStreaming: false, messages: [] } } as unknown as Agent;
    const threadRef = "web:tester:reopened";
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef,
          sessionId: "reopened",
          scopeId: null,
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        hasLiveRun: () => false,
        drawActiveChat: () => render(composer!.composerForm(agent), host),
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;

    const loading = composer!.refreshRuntimeSelection(null, agent);
    composer!.adoptRuntime({ harnessId: "pi", modelId: "sonnet", effortLevel: "max", fastMode: false });
    releaseConfig();
    await loading;

    assert.equal(composer!.currentModelOption()?.value, "pi:sonnet");
    assert.equal(composer!.state.effortLevel, "max", "the session's effort beats the saved preset for that model");
    assert.equal(host.querySelector(".loadout-button")?.getAttribute("aria-label"), "Model: Sonnet 5.5, Max effort");
    assert.equal(agent.state.model?.id, "sonnet");

    (agent.state.messages as unknown[]).push({ role: "user", content: "keep going" });
    const streamFn = makeCoreStreamFn(threadRef, agent, () => ({
      harness: composer!.currentModelOption()!.harnessId,
      effortLevel: composer!.state.effortLevel,
    })) as unknown as (model: Model<Api>, context: unknown) => { result(): Promise<unknown> };
    await streamFn(agent.state.model as Model<Api>, { messages: [] }).result();
    assert.deepEqual(
      { harness: turns[0]?.harness, model: turns[0]?.model, thinkingLevel: turns[0]?.thinkingLevel },
      { harness: "pi", model: "sonnet", thinkingLevel: "max" },
    );

    const carried = composer!.selectedRuntime();
    ctx.chat.state.threadRef = "web:tester:fork";
    await composer!.refreshRuntimeSelection(null, agent);
    assert.equal(composer!.currentModelOption()?.value, "pi:opus", "a fresh thread starts on the default");
    composer!.adoptRuntime(carried);
    assert.equal(composer!.currentModelOption()?.value, "pi:sonnet", "a fork carries the whole runtime");
    assert.equal(composer!.state.effortLevel, "max");

    ctx.chat.state.threadRef = "web:tester:unsent";
    await composer!.refreshRuntimeSelection(null, agent);
    composer!.state.effortLevel = "high";
    composer!.adoptRuntime({ harnessId: "pi", modelId: "sonnet", effortLevel: "max" });
    assert.equal(composer!.currentModelOption()?.value, "pi:opus", "an unsent pick in this tab survives a reopen");
    assert.equal(composer!.state.effortLevel, "high");

    ctx.chat.state.threadRef = "web:tester:elsewhere";
    await composer!.refreshRuntimeSelection(null, agent);
    composer!.adoptRuntime({ harnessId: "codex", modelId: "retired", effortLevel: "max" });
    assert.equal(composer!.currentModelOption()?.value, "pi:opus", "a runtime this viewer cannot run is not adopted");
    composer!.adoptRuntime({ harnessId: "pi", modelId: "sonnet", effortLevel: "bogus" });
    assert.equal(composer!.currentModelOption()?.value, "pi:sonnet");
    assert.equal(composer!.state.effortLevel, "low", "an effort the model no longer offers is not pinned");

    ctx.chat.state.threadRef = threadRef;
    await composer!.refreshRuntimeSelection(null, agent);
    composer!.adoptRuntime({ harnessId: "pi", modelId: "opus", effortLevel: "high" });
    assert.equal(composer!.currentModelOption()?.value, "pi:opus", "a later turn elsewhere wins on the next reopen");
    assert.equal(composer!.state.effortLevel, "high");
  } finally {
    composer?.dispose();
    await vite.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
