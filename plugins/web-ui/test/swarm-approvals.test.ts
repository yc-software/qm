import { metadata } from "./model-metadata.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Conversation } from "../src/conv-types.ts";
import type { PendingApproval } from "../src/core-bridge.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("worker transcripts allow approvals without enabling the composer", async () => {
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

  const approval: PendingApproval = { requestId: "a1", command: "echo test", reason: "requires approval" };
  const row = {
    type: "dm" as const,
    createdAt: 0,
    id: "s1",
    threadRef: "swarm:root:worker",
    scopeId: "personal:owner",
    title: "Test",
  };
  const entries = [{ seq: 1, type: "user", createdAt: Date.now(), payload: { text: "run the command" } }];
  let pending = [approval];
  const decision = deferred<Response>();
  const continuation = deferred<Response>();
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.includes("runtime-config")) {
      return Response.json({
        scopeId: row.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["gpt-5.6-sol"] },
        modelCatalog: { "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol") },
        orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
        effective: { harnessId: "pi", modelId: "gpt-5.6-sol" },
        scopeOverride: null,
      });
    }
    if (path.startsWith("/api/approvals/")) {
      return decision.promise;
    }
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path === "/api/runs/r1") return continuation.promise;
    if (path.endsWith("/approvals")) return Response.json({ approvals: pending });
    if (path.startsWith("/api/sessions/s1")) {
      return Response.json({ session: row, entries, earlierEntries: 0 });
    }
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
    const { entriesToMessages } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
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
    const chat = conv;
    chat.mountReadOnly(row, entriesToMessages(entries, transcriptModel()));
    await until(() => !!host.querySelector(".approval-btn"));
    assert.equal(host.querySelector("textarea"), null);
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Allow once",
    )!;
    button.click();
    button.click();
    assert.equal(requests.filter((r) => r.path === "/api/approvals/a1").length, 1);
    decision.resolve(Response.json({ runId: "r1" }, { status: 202 }));
    pending = [];
    continuation.resolve(Response.json({ status: "done", result: { status: "ok", reply: "approved worker result" } }));
    await until(() => !host.querySelector(".approval-btn"));
    assert.equal(host.querySelector("textarea"), null);
    assert.equal(
      requests.some((r) => r.path === "/api/turn"),
      false,
    );
  } finally {
    decision.resolve(Response.json({ error: "test complete" }, { status: 503 }));
    continuation.resolve(Response.json({ status: "done", result: { status: "ok", reply: "done" } }));
    conv?.state.agent?.abort();
    await conv?.state.agent?.waitForIdle();
    conv?.composer.dispose();
    conv?.dispose();
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
