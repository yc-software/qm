import { metadata } from "./model-metadata.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingApproval, SessionEntry } from "../src/core-bridge.ts";
import { bootConversation, session, until } from "./dom-harness.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test("approval handoff unlocks queue and steer without losing pending decisions", async (t) => {
  const approval: PendingApproval = { requestId: "a1", command: "echo test", reason: "requires approval" };
  const entries: SessionEntry[] = [
    { seq: 1, type: "user", createdAt: Date.now(), payload: { text: "run the command" } },
  ];
  let selectedModelId = "gpt-5.6-sol";
  let modelDeleted = false;
  let pending = [approval];
  let decision = deferred<Response>();
  let continuation = deferred<Response>();
  const handoff = deferred<void>();
  let refreshGate: ReturnType<typeof deferred<void>> | undefined;
  let submitted = false;
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const route: typeof fetch = async (input, init) => {
    const path = String(input);
    requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.includes("runtime-config")) {
      if (init?.method === "PUT") selectedModelId = JSON.parse(String(init.body)).modelId;
      return Response.json({
        scopeId: session.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: modelDeleted ? ["replacement-api"] : ["gpt-5.6-sol"] },
        modelCatalog: modelDeleted
          ? { "replacement-api": metadata("replacement-api", "Replacement API") }
          : { "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol") },
        orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
        effective: { harnessId: "pi", modelId: selectedModelId },
        scopeOverride: modelDeleted ? { harnessId: "pi", modelId: selectedModelId } : null,
        ...(modelDeleted && selectedModelId === "deleted-overlay"
          ? { unavailableReason: "Model has been deleted; select another model" }
          : {}),
      });
    }
    if (path.startsWith("/api/approvals/")) {
      submitted = true;
      return decision.promise;
    }
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path === "/api/runs/r1") return continuation.promise;
    if (path === "/api/runs/q1") return Response.json({ status: "done", result: { status: "ok", reply: "done" } });
    if (path === "/api/turn") return Response.json({ runId: "q1" });
    if (path === "/api/runs/q1/withdraw") return Response.json({ withdrawn: true });
    if (path === "/api/runs/r1/signal") return Response.json({ accepted: true });
    if (path.endsWith("/approvals")) return Response.json({ approvals: pending });
    if (path.startsWith("/api/sessions/s1")) {
      if (submitted) await handoff.promise;
      await refreshGate?.promise;
      return Response.json({ session, entries, earlierEntries: 0 });
    }
    if (path === "/api/sessions") return Response.json({ sessions: [session] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const boot = await bootConversation({ entries, fetch: route });
  const { conv: chat, host } = boot;
  try {
    function mount() {
      boot.mount(pending);
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
    await until(() => !!chat.composer.currentModelOption() && !!host.querySelector(".approval-btn"));

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
      assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')?.disabled, false);
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
        threadRef: session.threadRef,
        scopeId: session.scopeId,
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

    await t.test("settling a previous run cannot clear a repeated approval's submission", async () => {
      submitted = false;
      pending = [approval];
      decision = deferred<Response>();
      continuation = deferred<Response>();
      mount();
      click("Allow once");
      decision.resolve(Response.json({ runId: "r1" }));
      await until(() => chat.state.agent!.state.isStreaming && chat.hasLiveRun());
      refreshGate = deferred<void>();
      continuation.resolve(
        Response.json({ status: "done", result: { status: "pending_approval", pendingApprovals: pending } }),
      );
      await until(() => !chat.state.agent!.state.isStreaming && !!host.querySelector(".approval-btn"));
      decision = deferred<Response>();
      click("Allow once");
      assert.equal(chat.state.resolvingApprovals.size, 1);
      refreshGate.resolve();
      refreshGate = undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        assert.equal(chat.state.resolvingApprovals.size, 1);
        assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled, true);
      } finally {
        decision.resolve(Response.json({ error: "new request failed" }, { status: 503 }));
        await until(() => chat.state.resolvingApprovals.size === 0);
      }
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
    await t.test("deleted selection blocks sends, renders transcript and offers explicit replacement", async () => {
      submitted = false;
      pending = [];
      selectedModelId = "deleted-overlay";
      modelDeleted = true;
      mount();
      await chat.composer.refreshRuntimeSelection(session.scopeId, chat.state.agent!);
      await until(() => !!host.querySelector('select[aria-label="Replacement model"]'));
      assert.equal(chat.composer.currentModelOption(), undefined);
      assert.match(host.textContent ?? "", /deleted-overlay/);
      assert.match(host.textContent ?? "", /run the command/);
      assert.equal(host.querySelector("textarea"), null);
      assert.equal(host.querySelector("button.send-btn"), null);
      const replacement = host.querySelector<HTMLSelectElement>('select[aria-label="Replacement model"]')!;
      assert.ok([...replacement.options].some((option) => option.value === "pi:replacement-api"));
      const writes = requests.filter((request) => request.path === "/api/turn").length;
      replacement.value = "pi:replacement-api";
      replacement.dispatchEvent(new Event("change", { bubbles: true }));
      await until(() => chat.composer.currentModelOption()?.model.id === "replacement-api");
      assert.equal(selectedModelId, "replacement-api");
      await until(() => !!host.querySelector("textarea"));
      assert.equal(requests.filter((request) => request.path === "/api/turn").length, writes);
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = "Continue with my chosen replacement";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await until(() => host.querySelector<HTMLButtonElement>("button.send-btn")?.disabled === false);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await until(() => requests.filter((request) => request.path === "/api/turn").length === writes + 1);
      assert.equal(requests.filter((request) => request.path === "/api/turn").at(-1)?.body?.model, "replacement-api");
    });
  } finally {
    handoff.resolve();
    refreshGate?.resolve();
    decision.resolve(Response.json({ error: "test complete" }, { status: 503 }));
    continuation.resolve(Response.json({ status: "done", result: { status: "ok", reply: "done" } }));
    await boot.dispose();
  }
});
