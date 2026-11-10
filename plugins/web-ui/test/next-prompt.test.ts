import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { testViteServer } from "./vite-server.ts";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("a finished reply shows the predicted next message in the empty composer and Tab fills it in", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const requests: string[] = [];
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
    KeyboardEvent: dom.window.KeyboardEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return String(input).endsWith("/next-prompt")
        ? Response.json({ enabled: true, suggestion: "merge it" })
        : Response.json({ sessions: [] });
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
      models: ["alpha"],
      modelCatalog: { alpha: model },
      orgDefault: { modelId: "alpha", revision: 1 },
      effective: { modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const host = document.querySelector<HTMLElement>("#composer")!;
    const agent = {
      state: {
        isStreaming: false,
        model,
        messages: [
          { role: "user", content: "open the PR", ts: "1" },
          { role: "assistant", content: [{ type: "text", text: "PR is up and CI is green." }], ts: "2" },
        ],
      },
      prompt: async () => {},
    } as unknown as Agent;
    let drawn = 0;
    const draw = (): void => {
      drawn++;
      render(composer!.composerForm(agent), host);
    };
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef: "web:tester:next-prompt",
          sessionId: "s-next",
          scopeId: null,
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        turnRuntime: () => null,
        isStopping: () => false,
        hasLiveRun: () => false,
        drawActiveChat: draw,
        notePendingSessionOnSend() {},
        scrollToBottom() {},
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    const input = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>("textarea")!;
    draw();
    while (drawn < 2) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      requests.filter((r) => r.endsWith("/next-prompt")),
      ["/api/sessions/s-next/next-prompt"],
    );
    assert.equal(input().placeholder, "merge it");
    draw();
    assert.equal(requests.filter((r) => r.endsWith("/next-prompt")).length, 1, "one request per finished reply");

    input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(composer!.state.draft, "merge it");
    assert.equal(input().value, "merge it");
  } finally {
    composer?.dispose();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
