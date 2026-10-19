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

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

test("opening a chat draws the transcript before its approvals arrive", async (t) => {
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

  const scopeId = "personal:owner";
  const rows = ["s1", "s2", "s3"].map((id) => ({
    id,
    threadRef: `web:owner:${id}`,
    scopeId,
    title: id,
    canContinue: true,
  }));
  const entriesFor = (id: string) => [
    { seq: 1, type: "user", createdAt: Date.now(), payload: { text: `hello from ${id}` } },
  ];
  const approvalGates = new Map<string, ReturnType<typeof deferred<Response>>>();
  const gate = (id: string) => {
    let g = approvalGates.get(id);
    if (!g) approvalGates.set(id, (g = deferred<Response>()));
    return g;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["gpt-5.6-sol"] },
        modelCatalog: { "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol") },
        orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
        effective: { harnessId: "pi", modelId: "gpt-5.6-sol" },
        scopeOverride: null,
      });
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    const approvals = path.match(/^\/api\/sessions\/(s\d)\/approvals$/);
    if (approvals) return gate(approvals[1]!).promise;
    const session = path.match(/^\/api\/sessions\/(s\d)(\?|$)/);
    if (session) {
      const row = rows.find((r) => r.id === session[1])!;
      return Response.json({ session: row, entries: entriesFor(row.id), earlierEntries: 0 });
    }
    if (path === "/api/sessions") return Response.json({ sessions: rows });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    return Response.json({});
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState, openSessionInto } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    seedRuntimeConfig(scopeId, await (await fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = rows;
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    const conv = createConversation({
      pane: true,
      ownsUrl: false,
      container: () => host,
      claimContainer: () => host,
      visible: () => true,
      density: () => "full",
      onDensityChange() {},
      ensureDeliveryStream() {},
    }) as Conversation;
    const open = (id: string, approvalsPrefetch?: Promise<{ approvals: PendingApproval[] } | null>) =>
      openSessionInto(
        conv,
        rows.find((r) => r.id === id)!,
        undefined,
        approvalsPrefetch,
        false,
      );
    const text = () => host.textContent ?? "";
    const cards = () => host.querySelectorAll(".approval-btn").length;
    // A blocking approval swaps the message box for the approve/deny panel.
    const composerLocked = () => conv.hasUnresolvedApproval() && !host.querySelector("textarea");

    await t.test("transcript mounts while approvals are in flight; the card attaches afterwards", async () => {
      const opened = open("s1");
      await until(() => /hello from s1/.test(text()));
      await opened;
      assert.equal(conv.state.sessionId, "s1");
      assert.equal(cards(), 0);
      assert.equal(composerLocked(), false);

      gate("s1").resolve(Response.json({ approvals: [{ requestId: "a1", command: "rm -rf build" }] }));
      await until(() => cards() > 0);
      assert.match(text(), /hello from s1/);
      assert.equal(composerLocked(), true, "a blocking approval locks the composer once it arrives");
      assert.deepEqual(
        conv.activePendingApprovals().map((a) => a.requestId),
        ["a1"],
      );
    });

    await t.test("approvals that land after switching away do not reach the new chat", async () => {
      void open("s2");
      await until(() => /hello from s2/.test(text()));
      void open("s3");
      await until(() => /hello from s3/.test(text()));
      gate("s2").resolve(Response.json({ approvals: [{ requestId: "a2", command: "deploy" }] }));
      await settle();
      assert.equal(cards(), 0);
      assert.deepEqual(conv.activePendingApprovals(), []);
      gate("s3").resolve(Response.json({ approvals: [] }));
      await settle();
      assert.equal(cards(), 0);
      assert.equal(composerLocked(), false);
    });

    await t.test("a prefetched approvals request feeds the late attach", async () => {
      const prefetch = deferred<{ approvals: PendingApproval[] } | null>();
      void open("s1", prefetch.promise);
      await until(() => /hello from s1/.test(text()));
      assert.equal(cards(), 0);
      prefetch.resolve({ approvals: [{ requestId: "a3", command: "send email", blocksInput: false }] });
      await until(() => cards() > 0);
      assert.equal(composerLocked(), false, "a non-blocking approval leaves the composer usable");
    });

    await t.test("a failed approvals request leaves the mounted chat alone", async () => {
      approvalGates.set("s2", deferred<Response>());
      void open("s2");
      await until(() => /hello from s2/.test(text()));
      gate("s2").resolve(new Response("boom", { status: 500 }));
      await settle();
      assert.match(text(), /hello from s2/);
      assert.equal(cards(), 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});
