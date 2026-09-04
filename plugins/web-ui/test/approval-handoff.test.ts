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

test("approval handoff unlocks queue and steer without losing pending decisions", async (t) => {
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
  const row = { id: "s1", threadRef: "web:owner:test", scopeId: "personal:owner", title: "Test" };
  const entries = [{ seq: 1, type: "user", createdAt: Date.now(), payload: { text: "run the command" } }];
  let pending = [approval];
  let decision = deferred<Response>();
  let continuation = deferred<Response>();
  const handoff = deferred<void>();
  let submitted = false;
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId: row.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["gpt-5.6-sol"] },
        orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
        effective: { harnessId: "pi", modelId: "gpt-5.6-sol" },
        scopeOverride: null,
      });
    if (path.startsWith("/api/approvals/")) {
      submitted = true;
      return decision.promise;
    }
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path === "/api/runs/r1") return continuation.promise;
    if (path === "/api/turn") return Response.json({ runId: "q1" });
    if (path === "/api/runs/q1/withdraw") return Response.json({ withdrawn: true });
    if (path === "/api/runs/r1/signal") return Response.json({ accepted: true });
    if (path.endsWith("/approvals")) return Response.json({ approvals: pending });
    if (path.startsWith("/api/sessions/s1")) {
      if (submitted) await handoff.promise;
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
    const { entriesToMessages, attachPendingApprovals } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
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
    function mount() {
      const messages = entriesToMessages(entries, transcriptModel());
      attachPendingApprovals(messages, pending, transcriptModel());
      chat.mountContinuable(row.threadRef, row.id, row.scopeId, messages);
      chat.state.agent!.convertToLlm = () => [{ role: "user", content: "run the command", timestamp: 0 }];
    }
    function click(label: string) {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      assert.ok(button, `missing ${label} button`);
      button.click();
    }
    mount();
    await until(() => !!host.querySelector(".approval-btn"));

    await t.test("submission and handoff suppress duplicate clicks and stale cards", async () => {
      click("Allow once");
      chat.resolveCommandApproval({ requestId: "a1", approved: true });
      assert.equal(requests.filter((r) => r.path === "/api/approvals/a1").length, 1);
      assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled, true);
      decision.resolve(Response.json({ runId: "r1" }, { status: 202 }));
      await until(() => requests.some((r) => r.path === "/api/sessions/s1"));
      assert.equal(chat.state.resolvingApprovals.size, 1);
      assert.equal(host.querySelector(".approval-btn"), null);
      handoff.resolve();
      await until(() => chat.state.agent!.state.isStreaming && chat.hasLiveRun());
    });

    await t.test("running continuation allows queueing and steering", async () => {
      await until(() => host.querySelector<HTMLTextAreaElement>("textarea")?.disabled === false);
      assert.equal(chat.state.resolvingApprovals.size, 0);
      assert.equal(host.querySelector<HTMLButtonElement>('[title="Attach files"]')?.disabled, false);
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = "use the smaller change";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await until(() => !!host.querySelector(".queued-steer"));
      click("Steer");
      await until(() => requests.some((r) => r.path === "/api/runs/r1/signal"));
      assert.deepEqual(requests.find((r) => r.path === "/api/runs/r1/signal")?.body, {
        kind: "steer",
        text: "use the smaller change",
      });
      assert.equal(chat.state.agent!.state.isStreaming, true);
    });

    await t.test("a subsequent pause still requires and accepts another decision", async () => {
      pending = [{ ...approval, requestId: "a2" }];
      continuation.resolve(
        Response.json({ status: "done", result: { status: "pending_approval", pendingApprovals: pending } }),
      );
      await until(() => !chat.state.agent!.state.isStreaming && !!host.querySelector(".approval-btn"));
      assert.equal(host.querySelector("textarea"), null);
      decision = deferred<Response>();
      click("Deny");
      await until(() => requests.some((r) => r.path === "/api/approvals/a2"));
      pending = [];
      continuation = deferred<Response>();
      continuation.resolve(Response.json({ status: "done", result: { status: "refused", reason: "approval denied" } }));
      decision.resolve(Response.json({ runId: "r1" }));
      await until(() => !chat.state.agent!.state.isStreaming && chat.state.resolvingApprovals.size === 0);
    });

    await t.test("submission errors restore the approval for retry", async () => {
      submitted = false;
      pending = [approval];
      decision = deferred<Response>();
      mount();
      click("Allow once");
      decision.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
      await until(() => chat.state.resolvingApprovals.size === 0 && !!host.querySelector(".approval-btn"));
      assert.match(chat.composer.state.error, /unavailable/i);
    });
    await t.test("a failed continuation does not leave the composer locked", async () => {
      submitted = false;
      pending = [approval];
      decision = deferred<Response>();
      continuation = deferred<Response>();
      mount();
      click("Allow once");
      decision.resolve(Response.json({ runId: "r1" }));
      await until(() => chat.state.agent!.state.isStreaming && chat.hasLiveRun());
      pending = [];
      continuation.resolve(Response.json({ status: "failed", result: { status: "refused", reason: "run failed" } }));
      await until(() => !chat.state.agent!.state.isStreaming);
      assert.equal(chat.state.resolvingApprovals.size, 0);
      await until(() => host.querySelector<HTMLTextAreaElement>("textarea")?.disabled === false);
    });

    await t.test("a late response cannot clear a new pane's pending submission", async () => {
      submitted = false;
      pending = [approval];
      decision = deferred<Response>();
      mount();
      click("Allow once");
      const oldDecision = decision;
      decision = deferred<Response>();
      mount();
      click("Allow once");
      oldDecision.resolve(Response.json({ error: "old request failed" }, { status: 503 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(chat.state.resolvingApprovals.size, 1);
      assert.equal(chat.composer.state.error, "");
      assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled, true);
      decision.resolve(Response.json({ error: "new request failed" }, { status: 503 }));
      await until(() => chat.state.resolvingApprovals.size === 0);
    });
  } finally {
    handoff.resolve();
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
