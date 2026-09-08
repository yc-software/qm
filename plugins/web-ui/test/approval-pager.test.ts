import { metadata } from "./model-metadata.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Conversation } from "../src/conv-types.ts";
import type { PendingApproval } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("the composer pages through pending approvals one card at a time", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', { url: "http://localhost/" });
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

  const pending: PendingApproval[] = ["rm -rf build", "git push --force", "npm publish"].map((command, i) => ({
    requestId: `a${i + 1}`,
    command,
    reason: "requires approval",
  }));
  const row = { id: "s1", threadRef: "web:owner:test", scopeId: "personal:owner", title: "Test" };
  const entries = [{ seq: 1, type: "user", createdAt: Date.now(), payload: { text: "ship it" } }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId: row.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["gpt-5.6-sol"] },
        modelCatalog: { "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol") },
        orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
        effective: { harnessId: "pi", modelId: "gpt-5.6-sol" },
        scopeOverride: null,
      });
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path.endsWith("/approvals")) return Response.json({ approvals: pending });
    if (path.startsWith("/api/sessions/s1")) return Response.json({ session: row, entries, earlierEntries: 0 });
    if (path === "/api/sessions") return Response.json({ sessions: [row] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let conv: Conversation | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { entriesToMessages, attachPendingApprovals } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/composer.ts");
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
    const messages = entriesToMessages(entries, transcriptModel());
    attachPendingApprovals(messages, pending, transcriptModel());
    conv.mountContinuable(row.threadRef, row.id, row.scopeId, messages);
    await until(() => !!conv!.composer.currentModelOption() && !!host.querySelector(".approval-pager-count"));

    const panel = () => host.querySelector(".composer-approval-panel")!;
    const count = () => panel().querySelector(".approval-pager-count")?.textContent?.trim();
    const shown = () => [...panel().querySelectorAll(".approval-cmd")].map((el) => el.textContent?.trim());
    const pagerButton = (label: string) => panel().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

    assert.equal(count(), "1/3");
    assert.deepEqual(shown(), ["rm -rf build"]);
    assert.equal(pagerButton("Previous approval").disabled, true);

    pagerButton("Next approval").click();
    await until(() => count() === "2/3");
    assert.deepEqual(shown(), ["git push --force"]);
    assert.equal(pagerButton("Previous approval").disabled, false);

    pagerButton("Next approval").click();
    await until(() => count() === "3/3");
    assert.deepEqual(shown(), ["npm publish"]);
    assert.equal(pagerButton("Next approval").disabled, true);
    assert.equal(panel().querySelectorAll(".approval-btn").length, 4);
  } finally {
    conv?.state.agent?.abort();
    await conv?.state.agent?.waitForIdle();
    conv?.composer.dispose();
    conv?.dispose();
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
