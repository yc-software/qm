import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("stopping returns Send immediately and queues every submit path without interrupting the live run", async (t) => {
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
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ runId: "queued-test", sessions: [] });
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
    const host = document.querySelector<HTMLElement>("#composer")!;
    let stopping = false;
    let prompts = 0;
    let stops = 0;
    const agentState = { isStreaming: true, model, messages: [] };
    const agent = {
      state: agentState,
      prompt: async () => {
        prompts++;
      },
    } as unknown as Agent;
    const draw = (): void => render(composer!.composerForm(agent), host);
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef: "web:tester:stopping",
          sessionId: "test-session",
          scopeId: null,
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        isStopping: () => stopping,
        drawActiveChat: draw,
        stopLiveRun: async () => {
          stops++;
          stopping = true;
          draw();
        },
        notePendingSessionOnSend() {},
        scrollToBottom() {},
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    const button = (selector: string): HTMLButtonElement => host.querySelector<HTMLButtonElement>(selector)!;
    const type = (value: string): void => {
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    composer!.state.draft = "Keep this draft";
    draw();
    assert.equal(button(".send-btn").disabled, false);
    button(".stop-btn").click();
    assert.equal(stops, 1);
    assert.equal(host.querySelector(".stop-btn"), null);
    assert.equal(button(".send-btn").getAttribute("aria-label"), "Send");
    assert.equal(button(".send-btn").disabled, false);
    assert.equal(composer!.state.draft, "Keep this draft");
    assert.equal(agentState.isStreaming, true);
    for (const submit of ["enter", "ctrl-enter", "meta-enter", "form"]) {
      await t.test(`${submit} queues while stopping`, async () => {
        type(`Next instruction via ${submit}`);
        assert.equal(button(".send-btn").disabled, false);
        assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.disabled, false);
        const before = requests.length;
        if (submit === "form") {
          host
            .querySelector("form")!
            .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        } else {
          host.querySelector("textarea")!.dispatchEvent(
            new dom.window.KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
              ctrlKey: submit === "ctrl-enter",
              metaKey: submit === "meta-enter",
            }),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(requests.slice(before), ["/api/turn"]);
        assert.equal(prompts, 0);
        assert.equal(composer!.state.draft, "");
        assert.equal(agentState.isStreaming, true);
        assert.equal(stopping, true);
      });
    }
    const attachment = {
      id: "test-file",
      type: "document" as const,
      fileName: "draft.txt",
      mimeType: "text/plain",
      size: 1,
      content: "eA==",
    };
    composer!.state.attachments = [attachment];
    draw();
    assert.equal(button(".send-btn").disabled, false, "attachments can be queued while stopping");
    assert.deepEqual(composer!.state.attachments, [attachment]);
    composer!.state.attachments = [];
    stopping = false;
    agentState.isStreaming = false;
    composer!.state.draft = "Resume sending";
    draw();
    assert.equal(button(".send-btn").disabled, false, "sending recovers after stop completes");
    host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(prompts, 1, "normal submission still works");
    agentState.isStreaming = true;
    composer!.state.draft = "Queue normally";
    draw();
    assert.equal(button(".send-btn").disabled, false);
    host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(requests, Array(5).fill("/api/turn"), "normal queue submission still works");
    composer!.state.draft = "Preparing attachment";
    composer!.state.processingFiles = true;
    draw();
    assert.equal(button(".send-btn").disabled, true, "queue shares file-processing guard");
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

test("disabled Stop shares Send's muted styling", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  assert.match(css, /\.send-btn:disabled,\s*\.stop-btn:disabled\s*\{[^}]*opacity: 0\.35;[^}]*cursor: not-allowed;/);
});
