import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";
import type { RuntimeConfig } from "../src/core-bridge.ts";
import type { ModelMetadata } from "../src/pi-models.ts";
import type { LoadoutEntry } from "../src/composer-loadout.ts";

function model(id: string, label: string, provider = "anthropic"): ModelMetadata {
  return {
    id,
    name: label,
    label,
    buttonLabel: label,
    provider,
    api: provider === "openai" ? "openai-responses" : "anthropic-messages",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
    fastMode: true,
  };
}

test("the shared picker preserves composer choices and saves context defaults", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/web-ui/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.hidden ? null : dom.window.document.body;
    },
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new dom.window.Event("close"));
  };
  const updates: Record<string, unknown>[] = [];
  let failNextGet = true;
  let failNextPut = false;
  let deferNextPut = false;
  let pendingPut: Promise<void> | undefined;
  const extraComposers: ComposerSurface[] = [];
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
      if (String(input).startsWith("/api/runtime-config") && init?.method !== "PUT") {
        if (failNextGet) {
          failNextGet = false;
          return Response.json({ error: "initial load failed" }, { status: 500 });
        }
        return Response.json(config);
      }
      if (String(input) !== "/api/runtime-config" || init?.method !== "PUT")
        throw new Error(`Unexpected request: ${String(input)}`);
      if (failNextPut) {
        failNextPut = false;
        return Response.json({ error: "default save failed" }, { status: 500 });
      }
      const change = JSON.parse(String(init.body));
      updates.push(change);
      if (deferNextPut) {
        deferNextPut = false;
        await pendingPut;
      }
      if (change.inherit) return Response.json({ ...config, effective: config.orgDefault, scopeOverride: null });
      const effective = {
        harnessId: change.harnessId,
        modelId: change.modelId,
        effortLevel: change.effortLevel,
        fastMode: change.fastMode,
      };
      return new Response(
        JSON.stringify({
          ...config,
          scopeId: change.scopeId,
          effective,
          scopeOverride: { ...effective, orgRevision: 1 },
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const config: RuntimeConfig = {
    scopeId: "personal:tester",
    approvedHarnesses: ["pi", "claude", "opencode", "codex"],
    modelsByHarness: {
      pi: ["alpha", "gamma", "delta", "epsilon"],
      claude: ["alpha", "delta"],
      opencode: ["alpha"],
      codex: ["beta"],
    },
    modelCatalog: {
      alpha: model("alpha", "Alpha"),
      beta: model("beta", "Beta", "openai"),
      gamma: model("gamma", "Gamma", "openai"),
      delta: model("delta", "Delta"),
      epsilon: model("epsilon", "Epsilon"),
    },
    orgDefault: { harnessId: "claude", modelId: "alpha", revision: 1 },
    effective: { harnessId: "claude", modelId: "alpha" },
    scopeOverride: null,
    upgradeAvailable: false,
    fastModeModelIds: ["alpha", "beta"],
  };
  localStorage.setItem(
    "web-ui:loadout",
    JSON.stringify([
      { value: "codex:beta", effort: "xhigh", fast: false },
      { value: "claude:alpha", effort: "high", fast: true },
      { value: "pi:alpha", effort: "low", fast: false },
      { value: "pi:gamma", effort: "medium", fast: false },
    ]),
  );
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let composer: ComposerSurface | undefined;
  let siblingComposer: ComposerSurface | undefined;
  let resetContext: (() => void) | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test" };
    const host = document.querySelector<HTMLElement>("#composer")!;
    const agent = { state: { isStreaming: false, messages: [] } } as unknown as Agent;
    const draw = (): void => render(composer!.composerForm(agent), host);
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef: "web:tester:picker-test",
          sessionId: null,
          scopeId: null,
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        hasLiveRun: () => false,
        drawActiveChat: draw,
      },
    } as unknown as ConvCtx;
    const mount = async (): Promise<void> => {
      composer?.dispose();
      composer = createComposerSurface(ctx);
      ctx.composer = composer!;
      await composer!.refreshRuntimeSelection(null, agent);
    };
    const tick = async (): Promise<void> => {
      await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    };
    const button = (selector: string): HTMLButtonElement => {
      if (selector !== ".loadout-button" && !host.querySelector(".loadout-popover"))
        host.querySelector<HTMLButtonElement>(".loadout-button")!.click();
      const target = host.querySelector<HTMLButtonElement>(selector);
      assert.ok(target, `button exists: ${selector}`);
      return target;
    };
    const pick = (label: string): HTMLButtonElement => {
      if (!host.querySelector(".loadout-popover")) button(".loadout-button").click();
      const target = [...host.querySelectorAll<HTMLButtonElement>(".loadout-pick")].find(
        (row) => row.querySelector(".loadout-name")?.textContent === label,
      );
      assert.ok(target, `saved model exists: ${label}`);
      return target;
    };
    const saved = (): LoadoutEntry[] => JSON.parse(localStorage.getItem("web-ui:loadout") ?? "[]");
    const names = (): Array<string | null> =>
      [...host.querySelectorAll(".loadout-pick .loadout-name")].map((row) => row.textContent);

    await mount();
    assert.match(composer!.state.error, /Could not load runtime settings/);
    await composer!.refreshRuntimeSelection(null, agent);
    assert.equal(composer!.state.effortLevel, "high", "retry restores saved preset effort");
    assert.equal(composer!.state.fastMode, true, "retry restores saved preset Fast");
    await composer!.refreshRuntimeSelection(null, agent, true);
    assert.equal(composer!.state.effortLevel, "high", "identical refresh preserves restored effort");
    assert.equal(composer!.state.fastMode, true, "identical refresh preserves restored Fast");
    const siblingHost = document.createElement("section");
    document.body.append(siblingHost);
    const siblingAgent = { state: { isStreaming: false, messages: [] } } as unknown as Agent;
    const siblingCtx = {
      ...ctx,
      chat: {
        ...ctx.chat,
        state: { ...ctx.chat.state, host: siblingHost, agent: siblingAgent, threadRef: "web:tester:sibling" },
        drawActiveChat: () => render(siblingComposer!.composerForm(siblingAgent), siblingHost),
      },
    } as unknown as ConvCtx;
    siblingComposer = createComposerSurface(siblingCtx);
    await siblingComposer!.refreshRuntimeSelection(null, siblingAgent);
    siblingHost.querySelector<HTMLButtonElement>(".loadout-button")!.click();
    failNextPut = true;
    siblingHost.querySelector<HTMLButtonElement>('[aria-label="Make Beta default"]')!.click();
    await tick();
    assert.match(siblingComposer!.state.error, /default save failed/);
    assert.equal(siblingComposer!.currentModelOption()?.value, "claude:alpha");
    assert.equal(siblingComposer!.state.effortLevel, "high");
    assert.equal(siblingComposer!.state.fastMode, true);
    assert.equal(
      JSON.parse(localStorage.getItem("web-ui:model-picks") ?? "[]").some(
        ([ref]: [string, string]) => ref === "web:tester:sibling",
      ),
      false,
    );
    assert.equal(host.querySelector('.composer-toolbar [aria-label="Harness"]'), null);
    assert.equal(host.querySelector(".composer-toolbar .harness-control"), null);
    assert.equal(host.querySelectorAll('.composer-toolbar [aria-haspopup="menu"]').length, 1);
    button(".loadout-button").click();
    await tick();
    assert.deepEqual(names(), ["Beta", "Alpha", "Gamma"]);
    assert.ok(pick("Beta").querySelector('[aria-label="Codex"]'));
    assert.ok(pick("Gamma").querySelector('[aria-label="OpenAI"]'));
    assert.equal(pick("Gamma").querySelector('[aria-label="Codex"]'), null);
    assert.equal(pick("Alpha").querySelector(".loadout-harness")?.textContent, "Claude Code");
    assert.equal(host.querySelectorAll(".loadout-default").length, 1);
    assert.equal(pick("Alpha").querySelector(".loadout-default")?.textContent, "my default");
    pick("Beta").click();
    assert.equal(pick("Beta").getAttribute("aria-checked"), "true");
    assert.equal(pick("Beta").querySelector(".loadout-default"), null);
    assert.equal(pick("Alpha").querySelector(".loadout-default")?.textContent, "my default");
    pick("Alpha").click();

    button('[data-loadout-section="harness"]').click();
    await tick();
    const choices = [...host.querySelectorAll<HTMLButtonElement>('.loadout-submenu [role="menuitemradio"]')];
    assert.deepEqual(
      choices.map((choice) => choice.textContent?.trim()),
      ["Pi", "Claude Code", "OpenCode", "Codex"],
    );
    assert.equal(choices[3]!.getAttribute("aria-disabled"), "true");
    assert.equal(choices[3]!.getAttribute("aria-description"), "Codex cannot run Alpha.");
    choices[3]!.dispatchEvent(new MouseEvent("mouseenter"));
    assert.equal(document.querySelector(".qm-tooltip.visible")?.textContent, "Codex cannot run Alpha.");
    const beforeDisabledClick = saved();
    const beforeDisabledUpdates = updates.length;
    choices[3]!.click();
    assert.equal(composer!.currentModelOption()?.value, "claude:alpha");
    assert.deepEqual(saved(), beforeDisabledClick);
    assert.equal(updates.length, beforeDisabledUpdates);
    assert.ok(host.querySelector(".loadout-submenu"));
    assert.equal(choices[1]!.getAttribute("aria-checked"), "true");
    assert.equal(document.activeElement, choices[1]);
    choices[0]!.click();
    await tick();
    assert.equal(composer!.currentModelOption()?.value, "pi:alpha");
    assert.equal(pick("Alpha").querySelector(".loadout-default"), null);
    assert.equal(agent.state.model.id, "alpha");
    assert.equal(host.querySelector(".loadout-submenu"), null);
    assert.equal(document.activeElement, button('[data-loadout-section="harness"]'));
    assert.deepEqual(names(), ["Beta", "Alpha", "Gamma"]);
    assert.deepEqual(saved(), [
      { value: "codex:beta", effort: "xhigh", fast: false },
      { value: "pi:alpha", effort: "high", fast: true },
      { value: "pi:gamma", effort: "medium", fast: false },
    ]);

    button('[data-loadout-section="add"]').click();
    await tick();
    const catalog = [...host.querySelectorAll(".loadout-submenu .menu-option")];
    assert.equal(catalog.length, 2);
    assert.match(catalog[0]!.textContent ?? "", /Delta/);
    button(".loadout-back").click();

    pick("Beta").click();
    assert.equal(composer!.currentModelOption()?.value, "codex:beta");
    button('[data-loadout-section="harness"]').click();
    await tick();
    const betaChoices = [...host.querySelectorAll<HTMLButtonElement>('.loadout-submenu [role="menuitemradio"]')];
    assert.deepEqual(
      betaChoices.map((choice) => choice.getAttribute("aria-disabled")),
      ["true", "true", "true", "false"],
    );
    const claude = betaChoices[1]!;
    claude.focus();
    assert.equal(document.querySelector(".qm-tooltip.visible")?.textContent, "Claude Code cannot run Beta.");
    claude.click();
    assert.equal(composer!.currentModelOption()?.value, "codex:beta");
    button(".loadout-back").click();
    pick("Alpha").click();
    assert.equal(composer!.currentModelOption()?.value, "pi:alpha");
    assert.equal(composer!.state.effortLevel, "high");
    assert.equal(composer!.state.fastMode, true);
    assert.equal(pick("Alpha").querySelector(".loadout-harness")?.textContent, "Pi");

    await mount();
    assert.equal(composer!.currentModelOption()?.value, "pi:alpha");
    assert.equal(composer!.state.effortLevel, "high");
    assert.equal(composer!.state.fastMode, true);
    button(".loadout-button").click();
    assert.deepEqual(names(), ["Beta", "Alpha", "Gamma"]);
    assert.equal(pick("Alpha").querySelector(".loadout-harness")?.textContent, "Pi");
    await tick();

    ctx.chat.state.threadRef = "web:tester:picker-new-thread";
    await mount();
    assert.equal(composer!.currentModelOption()?.value, "pi:alpha");
    assert.equal(agent.state.model.id, "alpha");
    assert.equal(composer!.state.effortLevel, "high");
    assert.equal(composer!.state.fastMode, true);
    button(".loadout-button").click();
    assert.deepEqual(names(), ["Beta", "Alpha", "Gamma"]);
    assert.equal(pick("Alpha").querySelector(".loadout-harness")?.textContent, "Pi");

    button('[data-loadout-section="harness"]').click();
    const openCode = [...host.querySelectorAll<HTMLButtonElement>('.loadout-submenu [role="menuitemradio"]')].find(
      (choice) => choice.textContent?.trim() === "OpenCode",
    );
    assert.ok(openCode);
    openCode.click();
    assert.equal(composer!.currentModelOption()?.value, "opencode:alpha");
    assert.equal(agent.state.model.id, "alpha");
    assert.equal(composer!.state.effortLevel, "auto");
    assert.equal(composer!.state.fastMode, false);
    assert.deepEqual(saved()[1], { value: "opencode:alpha", effort: "auto", fast: false });
    assert.equal(host.querySelector('[data-loadout-section="effort"]'), null);
    const unavailableFast = button('[aria-label="Fast"][role="menuitemcheckbox"]');
    assert.equal(unavailableFast.disabled, true);
    assert.equal(unavailableFast.querySelector(".loadout-shortcut")?.textContent, "Not supported by this harness");
    assert.equal(unavailableFast.getAttribute("aria-checked"), "false");
    unavailableFast.click();
    assert.equal(composer!.state.fastMode, false);

    button('[data-loadout-section="harness"]').click();
    const pi = [...host.querySelectorAll<HTMLButtonElement>('.loadout-submenu [role="menuitemradio"]')].find(
      (choice) => choice.textContent?.trim() === "Pi",
    );
    assert.ok(pi);
    pi.click();
    assert.equal(composer!.currentModelOption()?.value, "pi:alpha");
    assert.equal(composer!.state.effortLevel, "auto");
    assert.equal(composer!.state.fastMode, false);
    assert.deepEqual(names(), ["Beta", "Alpha", "Gamma"]);
    assert.equal(button('[aria-label="Fast"][role="menuitemcheckbox"]').disabled, false);
    pick("Gamma").click();
    button(".loadout-button").click();
    assert.equal(
      button('[aria-label="Fast"][role="menuitemcheckbox"]').querySelector(".loadout-shortcut")?.textContent,
      "Not supported by this model",
    );
    assert.equal(button('[aria-label="Fast"][role="menuitemcheckbox"]').disabled, true);
    assert.equal(button('[aria-label="Fast"][role="menuitemcheckbox"]').getAttribute("aria-checked"), "false");
    pick("Alpha").click();
    button(".loadout-button").click();
    assert.equal(button('[aria-label="Fast"][role="menuitemcheckbox"]').disabled, false);
    await tick();

    button('[data-loadout-section="harness"]').click();
    await tick();
    assert.ok(host.querySelector(".loadout-submenu"));
    assert.equal(composer!.closeMenus(), true);
    draw();
    assert.equal(host.querySelector(".loadout-popover"), null);
    button(".loadout-button").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await tick();
    assert.ok(host.querySelector(".loadout-popover"));
    assert.equal(host.querySelector(".loadout-submenu"), null);
    assert.equal(document.activeElement?.matches(".loadout-pick"), true);
    assert.equal(host.querySelector(".model-settings-trigger"), null);
    assert.equal(document.querySelector(".model-settings-modal"), null);
    pick("Alpha").click();
    const current = {
      value: composer!.currentModelOption()?.value,
      effort: composer!.state.effortLevel,
      fast: composer!.state.fastMode,
    };
    const betaDefault = pick("Beta")
      .closest(".loadout-row")!
      .querySelector<HTMLButtonElement>(".loadout-make-default")!;
    betaDefault.click();
    await tick();
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      harnessId: "codex",
      modelId: "beta",
      effortLevel: "xhigh",
      fastMode: false,
      scopeId: config.scopeId,
    });
    assert.deepEqual(
      {
        value: composer!.currentModelOption()?.value,
        effort: composer!.state.effortLevel,
        fast: composer!.state.fastMode,
      },
      current,
    );
    assert.equal(
      siblingComposer!.currentModelOption()?.value,
      "codex:beta",
      "failed save did not pin an untouched sibling",
    );
    assert.equal(siblingComposer!.state.effortLevel, "xhigh", "sibling follows the new default effort");
    assert.equal(siblingComposer!.state.fastMode, false, "sibling follows the new default Fast setting");
    assert.equal(siblingAgent.state.model.id, "beta");
    assert.equal(pick("Beta").querySelector(".loadout-default")?.textContent, "my default");
    assert.equal(pick("Beta").querySelector(".loadout-default svg"), null);
    assert.ok(pick("Beta").closest(".loadout-row")!.querySelector(".loadout-default-star svg"));
    assert.equal(pick("Beta").closest(".loadout-row")!.querySelector(".loadout-make-default"), null);
    assert.equal(pick("Alpha").getAttribute("aria-checked"), "true");
    button('[data-loadout-section="add"]').click();
    await tick();
    button(".loadout-back").hidden = true;
    const search = host.querySelector<HTMLInputElement>(".loadout-search input")!;
    const results = [...host.querySelectorAll<HTMLButtonElement>(".loadout-submenu .menu-option")];
    assert.equal(results.length, 2);
    search.focus();
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    assert.equal(document.activeElement, results.at(-1));
    search.focus();
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.equal(document.activeElement, results[0]);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    assert.equal(document.activeElement, button('[data-loadout-section="add"]'));
    pick("Gamma").click();
    assert.equal(updates.length, 1);
    await tick();
    for (const field of ["effortLevel", "fastMode"] as const) {
      const pendingHost = document.createElement("section");
      document.body.append(pendingHost);
      const pendingAgent = { state: { isStreaming: false, messages: [] } } as unknown as Agent;
      const pendingCtx = {
        ...ctx,
        chat: {
          ...ctx.chat,
          state: {
            ...ctx.chat.state,
            host: pendingHost,
            agent: pendingAgent,
            threadRef: `web:tester:pending-${field}`,
          },
          drawActiveChat: () => render(pendingComposer.composerForm(pendingAgent), pendingHost),
        },
      } as unknown as ConvCtx;
      const pendingComposer = createComposerSurface(pendingCtx) as ComposerSurface;
      extraComposers.push(pendingComposer);
      await pendingComposer.refreshRuntimeSelection(null, pendingAgent);
      const selectedBefore = pendingComposer.currentModelOption()!;
      const effortBefore = pendingComposer.state.effortLevel;
      const fastBefore = pendingComposer.state.fastMode;
      pendingHost.querySelector<HTMLButtonElement>(".loadout-button")!.click();
      const target = [...pendingHost.querySelectorAll<HTMLButtonElement>(".loadout-make-default")].find(
        (button) => button.getAttribute("aria-label") !== `Make ${selectedBefore.label} default`,
      );
      assert.ok(target);
      deferNextPut = true;
      const gate = Promise.withResolvers<void>();
      pendingPut = gate.promise;
      target.click();
      await tick();
      assert.equal(deferNextPut, false, "default save is pending");
      if (field === "effortLevel") pendingComposer.state.effortLevel = "high";
      else pendingComposer.state.fastMode = !fastBefore;
      gate.resolve();
      await tick();
      assert.equal(
        pendingComposer.currentModelOption()?.value,
        selectedBefore.value,
        `${field} edit does not change the selected model during a default save`,
      );
      assert.equal(pendingComposer.state.effortLevel, field === "effortLevel" ? "high" : effortBefore);
      assert.equal(pendingComposer.state.fastMode, field === "fastMode" ? !fastBefore : fastBefore);
      pendingComposer.dispose();
    }

    const context = await vite.ssrLoadModule("/src/context-model.ts");
    resetContext = context.resetContextModel;
    const contextHost = document.createElement("section");
    document.body.append(contextHost);
    const { replaceChildrenPreservingFocus } = await vite.ssrLoadModule("/src/pane-focus.ts");
    const drawContext = () => {
      const next = document.createElement("div");
      render(context.contextModelSection(config.scopeId), next);
      replaceChildrenPreservingFocus(contextHost, next);
    };
    await context.loadContextModel(config.scopeId, drawContext);
    const contextButton = (selector: string): HTMLButtonElement => {
      const result = contextHost.querySelector<HTMLButtonElement>(selector);
      assert.ok(result, `context button exists: ${selector}`);
      return result;
    };
    contextButton(".loadout-button").click();
    assert.ok(contextHost.querySelector('[role="menu"][aria-label="Model settings"]'));
    assert.equal(contextHost.querySelector("select"), null);
    assert.equal(contextHost.querySelector(".loadout-make-default"), null);
    const betaPreset = [...contextHost.querySelectorAll<HTMLButtonElement>(".loadout-pick")].find((item) =>
      item.textContent?.includes("Beta"),
    );
    assert.ok(betaPreset);
    betaPreset.click();
    await tick();
    assert.equal(context.contextModelState.config.effective.modelId, "beta");
    assert.equal(contextHost.querySelector(".loadout-popover"), null);
    contextButton(".loadout-button").click();
    contextButton('[data-loadout-section="effort"]').click();
    const high = [...contextHost.querySelectorAll<HTMLButtonElement>(".loadout-effort")].find(
      (item) => item.textContent?.trim() === "High",
    );
    assert.ok(high);
    const gate = Promise.withResolvers<void>();
    pendingPut = gate.promise;
    deferNextPut = true;
    high.click();
    assert.equal(contextButton(".loadout-button").disabled, true);
    assert.match(contextButton(".loadout-button").getAttribute("aria-label") ?? "", /High effort/);
    await tick();
    gate.resolve();
    await tick();
    assert.equal(context.contextModelState.config.effective.effortLevel, "high");
    assert.equal(contextButton(".loadout-button").disabled, false);
    contextButton('[aria-label="Fast"][role="menuitemcheckbox"]').click();
    await tick();
    assert.equal(context.contextModelState.config.effective.fastMode, true);
    assert.equal(updates.at(-1)?.effortLevel, "high");
    failNextPut = true;
    contextButton('[aria-label="Fast"][role="menuitemcheckbox"]').click();
    await tick();
    assert.match(contextHost.textContent ?? "", /default save failed/);
    assert.equal(context.contextModelState.config.effective.fastMode, true);
    assert.equal(contextButton('[aria-label="Fast"][role="menuitemcheckbox"]').getAttribute("aria-checked"), "true");
    contextButton(".loadout-button").dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyE", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
    assert.equal(context.contextModelState.config.effective.fastMode, false);
    contextButton(".loadout-foot-btn").click();
    await tick();
    assert.equal(context.contextModelState.config.scopeOverride, null);
    assert.doesNotMatch(contextHost.textContent ?? "", /Following the org default/);
    assert.equal(contextHost.querySelector(".loadout-foot-btn"), null);
    contextButton(".loadout-popover").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    assert.equal(contextHost.querySelector(".loadout-popover"), null);
    assert.equal(document.activeElement, contextButton(".loadout-button"));
    contextButton(".loadout-button").click();
    document.body.click();
    assert.equal(contextHost.querySelector(".loadout-popover"), null);
    contextButton(".loadout-button").click();
    contextButton('[data-loadout-section="add"]').click();
    for (const query of ["D", "De", "Del"]) {
      const input = contextHost.querySelector<HTMLInputElement>(".loadout-search input")!;
      input.focus();
      input.value = query;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      assert.equal(document.activeElement, contextHost.querySelector(".loadout-search input"));
      assert.equal((document.activeElement as HTMLInputElement).value, query);
    }
    contextButton('[aria-label="Add Delta to presets"]').click();
    await tick();
    assert.equal(contextHost.querySelector(".loadout-popover"), null);
    assert.equal(context.contextModelState.config.effective.modelId, "delta");
    contextButton(".loadout-button").click();
    contextButton('[data-loadout-section="harness"]').click();
    const harness = [...contextHost.querySelectorAll<HTMLButtonElement>(".loadout-effort")].find(
      (item) => item.textContent?.trim() === "Claude Code",
    )!;
    harness.focus();
    harness.click();
    await tick();
    assert.equal(context.contextModelState.config.effective.harnessId, "claude");
    assert.equal(document.activeElement, contextButton('[data-loadout-section="harness"]'));
    context.resetContextModel();
    drawContext();
    assert.equal(contextHost.querySelector(".context-model"), null);
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    const staleScope = "personal:stale-default";
    seedRuntimeConfig(staleScope, {
      ...config,
      scopeId: staleScope,
      effective: { harnessId: "removed", modelId: "retired" },
      orgDefault: { harnessId: "removed", modelId: "retired", revision: 1 },
      scopeOverride: null,
    });
    localStorage.removeItem("web-ui:loadout");
    const drawStale = () => {
      const next = document.createElement("div");
      render(context.contextModelSection(staleScope), next);
      replaceChildrenPreservingFocus(contextHost, next);
    };
    await context.loadContextModel(staleScope, drawStale);
    assert.match(contextHost.textContent ?? "", /retired.*no longer offered/);
    contextButton(".loadout-button").click();
    contextButton('[data-loadout-section="add"]').click();
    contextButton('[aria-label="Add Beta to presets"]').click();
    await tick();
    assert.deepEqual(updates.at(-1), {
      scopeId: staleScope,
      harnessId: "codex",
      modelId: "beta",
      effortLevel: "auto",
      fastMode: false,
    });
    assert.equal(context.contextModelState.config.effective.modelId, "beta");
  } finally {
    resetContext?.();
    composer?.dispose();
    siblingComposer?.dispose();
    for (const extra of extraComposers) extra.dispose();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
