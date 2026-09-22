import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";
import type { SuggestedActivity } from "../../chassis/src/suggested-activities.ts";

test("suggested prompts render below the composer", () => {
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  const dock = chat.slice(
    chat.indexOf('<div class="chat-bottom-dock">'),
    chat.indexOf("transcriptViewport.afterRender()"),
  );
  const composerIndex = dock.indexOf("ctx.composer.composerForm(agent)");
  const suggestionsIndex = dock.indexOf("suggestedActivities(");
  assert.notEqual(composerIndex, -1);
  assert.notEqual(suggestionsIndex, -1);
  assert.ok(composerIndex < suggestionsIndex);
});

test("activity selection fills and persists an editable draft without sending or overwriting work", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main></main>', {
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
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    fetch: async (input: RequestInfo | URL) => {
      assert.ok(String(input).startsWith("/api/runtime-config"), "activity selection must not submit a turn");
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["test-model"] },
        modelCatalog: {
          "test-model": {
            id: "test-model",
            name: "Test model",
            label: "Test model",
            buttonLabel: "Test model",
            provider: "anthropic",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 10000,
            maxTokens: 1000,
          },
        },
        effective: { harnessId: "pi", modelId: "test-model" },
        orgDefault: { harnessId: "pi", modelId: "test-model", revision: 1 },
        scopeOverride: null,
        upgradeAvailable: false,
        fastModeModelIds: [],
      });
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
    const { suggestedActivities } = await vite.ssrLoadModule("/src/suggested-activities.ts");
    const { storedDraft, newChatDraftKey } = await vite.ssrLoadModule("/src/drafts.ts");
    const { render, html } = await vite.ssrLoadModule("lit");
    const activities: SuggestedActivity[] = Array.from({ length: 4 }, (_, i) => ({
      id: `idea-${i}`,
      title: i === 0 ? "<img src=x onerror=alert(1)>" : `Activity ${i}`,
      prompt: `Draft request ${i}`,
      icon: ["🛠️", "yc", "app", "app"][i]!,
    }));
    appState.me = { user: "tester", org: "test", suggestedActivities: activities };
    const host = document.querySelector<HTMLElement>("main")!;
    const agentState = { isStreaming: false, messages: [] };
    const agent = { state: agentState } as unknown as Agent;
    const draw = () =>
      render(
        html`${suggestedActivities(appState.me.suggestedActivities, (activity: SuggestedActivity) => composer!.fillSuggestedPrompt(activity.prompt, agent), Boolean(composer!.state.draft || composer!.state.attachments.length))}${composer!.composerForm(agent)}`,
        host,
      );
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef: "web:tester:suggestions",
          sessionId: null,
          scopeId: null,
          resolvingApprovals: new Set(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        hasLiveRun: () => false,
        isStopping: () => false,
        drawActiveChat: draw,
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    await composer!.refreshRuntimeSelection(null, agent);
    draw();
    assert.equal(host.querySelectorAll(".suggested-activity").length, 3);
    assert.equal(host.querySelector(".suggested-activity-title")?.textContent, activities[0].title);
    assert.equal(host.querySelector("img"), null);
    const region = host.querySelector(".suggested-activities")!;
    assert.equal(host.querySelector(".suggested-activity-yc")?.textContent, "Y");
    assert.match(host.querySelector(".suggested-activity-icon")?.textContent ?? "", /🛠️/);
    host.querySelector<HTMLButtonElement>(".suggested-activity")!.click();
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    assert.equal(composer!.state.draft, "Draft request 0");
    assert.equal(storedDraft("web:tester:suggestions"), "Draft request 0");
    assert.equal(storedDraft(newChatDraftKey("tester")), "Draft request 0");
    assert.equal(document.activeElement, host.querySelector("textarea"));
    assert.equal(host.querySelector(".suggested-activities"), region);
    assert.equal(region.getAttribute("aria-hidden"), "true");
    assert.ok(region.hasAttribute("inert"));
    assert.equal(host.querySelectorAll(".suggested-activity:enabled").length, 0);
    assert.deepEqual(agent.state.messages, []);
    composer!.fillSuggestedPrompt("replacement", agent);
    assert.equal(composer!.state.draft, "Draft request 0");
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "";
    input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    assert.equal(host.querySelectorAll(".suggested-activity:enabled").length, 3);
    assert.equal(region.getAttribute("aria-hidden"), "false");
    assert.equal(region.hasAttribute("inert"), false);
    input.value = "My own draft";
    input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    assert.equal(host.querySelector(".suggested-activities"), region);
    assert.equal(region.getAttribute("aria-hidden"), "true");
    assert.ok(region.hasAttribute("inert"));
    assert.equal(host.querySelectorAll(".suggested-activity:enabled").length, 0);
    assert.equal(storedDraft(newChatDraftKey("tester")), "My own draft");
    composer!.state.draft = "";
    composer!.state.processingFiles = true;
    composer!.fillSuggestedPrompt("replacement", agent);
    assert.equal(composer!.state.draft, "");
    composer!.state.processingFiles = false;
    composer!.state.attachments.push({} as never);
    composer!.fillSuggestedPrompt("replacement", agent);
    assert.equal(composer!.state.draft, "");
    composer!.state.attachments.length = 0;
    agentState.isStreaming = true;
    composer!.fillSuggestedPrompt("replacement", agent);
    assert.equal(composer!.state.draft, "");
    appState.me.suggestedActivities = undefined;
    draw();
    assert.equal(host.querySelector(".suggested-activities"), null);
  } finally {
    composer?.dispose();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
