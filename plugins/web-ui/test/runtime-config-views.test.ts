import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ConvCtx, ComposerSurface } from "../src/conv-types.ts";
import { runtimeConfig } from "./runtime-fixture.ts";

test("runtime defaults are shared while pane choices and editor drafts remain local", async () => {
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

  const originalFetch = globalThis.fetch;
  const configs = new Map(
    ["personal:owner", "channel:other"].map((scope) => [scope, runtimeConfig(scope, { fastModeModelIds: ["model"] })]),
  );
  let fail = false;
  let gets = 0;
  globalThis.fetch = async (input, init) => {
    const scope = new URL(String(input), "http://localhost").searchParams.get("scopeId") ?? "personal:owner";
    if (init?.method === "PUT") {
      const change = JSON.parse(String(init.body));
      if (fail) return Response.json({ error: "save failed" }, { status: 500 });
      const config = {
        ...configs.get(change.scopeId)!,
        upgradeAvailable: false,
        effective: { harnessId: "pi", modelId: "model", effortLevel: "high", fastMode: true },
      };
      configs.set(change.scopeId, config);
      return Response.json(config);
    }
    gets++;
    return Response.json(configs.get(scope));
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const panes: Array<{ composer: ComposerSurface; ctx: ConvCtx; agent: Agent; host: HTMLElement }> = [];
  let resetPanel: (() => void) | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { saveRuntimeConfig, loadRuntimeConfig, seedRuntimeConfig } =
      await vite.ssrLoadModule("/src/runtime-config-store.ts");
    const { loadContextModel, resetContextModel, contextModelState } =
      await vite.ssrLoadModule("/src/context-model.ts");
    const { render } = await vite.ssrLoadModule("lit");
    resetPanel = resetContextModel;
    appState.me = { user: "owner", org: "test" };
    seedRuntimeConfig("personal:owner", configs.get("personal:owner"));
    for (const [i, scopeId] of [null, "personal:owner", "channel:other"].entries()) {
      const host = document.createElement("section");
      document.body.append(host);
      const agent = { state: { messages: [] } } as unknown as Agent;
      const ctx = {
        pane: true,
        container: () => host,
        visible: () => true,
        density: () => "full",
        chat: {
          state: { scopeId, threadRef: `thread-${i}`, sessionId: `session-${i}`, agent, resolvingApprovals: new Set() },
          activePendingApprovals: () => [],
          hasUnresolvedApproval: () => false,
          drawActiveChat: () => render(composer.composerForm(agent), host),
        },
      } as unknown as ConvCtx;
      const composer = createComposerSurface(ctx) as ComposerSurface;
      await composer.refreshRuntimeSelection(scopeId, agent);
      panes.push({ composer, ctx, agent, host });
    }
    await loadContextModel("personal:owner", () => {});
    assert.equal(gets, 1, "boot data hydrates both personal panes and settings without another fetch");
    panes[1]!.composer.state.effortLevel = "auto"; // Explicitly equal to the old default is still a choice.
    panes[1]!.composer.state.fastMode = false;
    panes[1]!.composer.state.draft = "keep my message";
    contextModelState.pending = "pi:pending-model";
    contextModelState.pendingEffort = "low";
    await saveRuntimeConfig("personal:owner", { inherit: true });
    assert.deepEqual(
      panes.map(({ host }) => host.querySelectorAll(".runtime-upgrade").length),
      [0, 0, 1],
    );
    assert.equal(panes[0]!.composer.state.effortLevel, "high", "untouched pane follows new defaults");
    assert.equal(panes[0]!.composer.state.fastMode, true);
    assert.equal(panes[1]!.composer.state.effortLevel, "auto", "explicit effort survives even if equal to old default");
    assert.equal(panes[1]!.composer.state.fastMode, false, "explicit off survives a new fast default");
    assert.equal(panes[1]!.composer.state.draft, "keep my message");
    assert.equal(contextModelState.config.upgradeAvailable, false);
    assert.equal(contextModelState.pending, "pi:pending-model");
    assert.equal(contextModelState.pendingEffort, "low");
    fail = true;
    await assert.rejects(saveRuntimeConfig("personal:owner", { keep: true }), /save failed/);
    assert.equal(panes[1]!.composer.state.effortLevel, "auto");
    fail = false;
    const stale = contextModelState.config;
    resetContextModel();
    await loadContextModel("channel:other", () => {});
    await saveRuntimeConfig("personal:owner", { keep: true });
    assert.equal(contextModelState.config.scopeId, "channel:other");
    assert.notEqual(contextModelState.config, stale);
    const sibling = panes[1]!;
    sibling.ctx.chat.state.scopeId = "channel:other";
    sibling.ctx.chat.state.threadRef = "thread-new";
    await sibling.composer.refreshRuntimeSelection("channel:other", sibling.agent);
    assert.equal(sibling.composer.state.effortLevel, "auto");
    assert.equal(sibling.composer.state.fastMode, false);
    await saveRuntimeConfig("personal:owner", { keep: true });
    assert.ok(sibling.host.querySelector(".runtime-upgrade"), "navigated pane ignores former scope");
    sibling.composer.dispose();
    const html = sibling.host.innerHTML;
    await saveRuntimeConfig("channel:other", { keep: true });
    assert.equal(sibling.host.innerHTML, html, "disposed pane does not redraw");
    // A server refresh uses the same publishing path as a local save.
    configs.set(
      "personal:owner",
      runtimeConfig("personal:owner", { effective: { harnessId: "pi", modelId: "model", effortLevel: "low" } }),
    );
    await loadRuntimeConfig("personal:owner", true);
    assert.equal(panes[0]!.composer.state.effortLevel, "low");
  } finally {
    resetPanel?.();
    for (const { composer } of panes) composer.dispose();
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
