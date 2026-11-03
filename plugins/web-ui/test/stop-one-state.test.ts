import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

const MODEL = {
  id: "m",
  name: "Model",
  label: "Model",
  buttonLabel: "Model",
  provider: "openai",
  api: "openai-responses",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

for (const opened of [false, true])
  test(`pressing Stop on a live turn with its fold ${opened ? "open" : "closed"} shows one Stopping… head until the turn ends`, async () => {
    const startedAt = Date.now() - 12_000;
    const activity: unknown[] = [
      {
        seq: 2,
        parentSeq: null,
        type: "tool_call",
        createdAt: startedAt,
        payload: { tool: "files", action: "read", callId: "c1", path: "docs/plan.md" },
      },
      {
        seq: 3,
        parentSeq: null,
        type: "tool_result",
        createdAt: startedAt + 1000,
        payload: { tool: "files", action: "read", callId: "c1", path: "docs/plan.md", bytes: 10 },
      },
      {
        seq: 4,
        parentSeq: null,
        type: "tool_call",
        createdAt: startedAt + 2000,
        payload: { tool: "execute", callId: "c2", command: "npm test", purpose: "Run the test suite" },
      },
    ];
    let signals = 0;
    let ended = false;
    const run = () =>
      ended
        ? {
            status: "done",
            alive: false,
            startedAt,
            finishedAt: Date.now(),
            attempt: 1,
            activity,
            result: { status: "ok", reply: "(stopped)", stopped: true },
          }
        : { status: "running", alive: true, startedAt, attempt: 1, activity, result: null };
    const h = await harness({
      path: `/s/${SESSION.id}`,
      listSessions: [SESSION],
      entries: [{ seq: 1, type: "user", createdAt: startedAt - 1000, payload: { text: "run the tests" } }],
      api: (path, init) => {
        if (path.startsWith("/api/runtime-config"))
          return Response.json({
            scopeId: "personal:tester",
            models: ["m"],
            modelCatalog: { m: MODEL },
            orgDefault: { modelId: "m", revision: 1 },
            scopeOverride: null,
            effective: { modelId: "m" },
            upgradeAvailable: false,
          });
        if (path.includes("/api/runs/active"))
          return Response.json(
            ended ? { runId: null, run: null, queued: [] } : { runId: "r1", run: run(), queued: [] },
          );
        if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
        if (path === "/api/runs/r1/signal" && init?.method === "POST") {
          signals++;
          return Response.json({ ok: true });
        }
        if (path === "/api/runs/r1") return Response.json(run());
        return undefined;
      },
    });
    try {
      h.releaseSessions();
      await h.boot();
      await h.sessionsReady();
      const main = () => document.querySelector<HTMLElement>(".main")!;
      const stopButton = () => document.querySelector<HTMLButtonElement>(".stop-btn");
      const fold = () => main().querySelector<HTMLDetailsElement>("details.work, details.stopped-work");
      await until(() => /Run the test suite/.test(fold()?.querySelector("summary")?.textContent ?? ""));
      await until(() => stopButton() !== null);
      if (opened) {
        fold()!.open = true;
        fold()!.dispatchEvent(new Event("toggle"));
        h.visibleConversation().drawActiveChat();
      }

      stopButton()!.click();
      await until(() => signals === 1);
      h.visibleConversation().drawActiveChat();

      const stoppingHeads = () =>
        [...main().querySelectorAll(".stopped-head, .work-head, .live-work-status")].filter((el) =>
          /Stop/.test(el.textContent ?? ""),
        );
      assert.equal(stoppingHeads().length, 1, "one stop head, not a fold label plus a separate status line");
      assert.equal(stoppingHeads()[0]!.textContent!.trim(), "Stopping…");
      assert.equal(fold()!.open, opened, "pressing Stop keeps the fold as the person left it");
      assert.ok(fold()!.classList.contains("stopped-work"), "the head takes its stopped shape when Stop is pressed");
      assert.equal(stopButton()?.disabled, true);
      assert.equal(stopButton()?.getAttribute("aria-label"), "Stopping…");
      assert.equal(document.querySelector(".send-btn")?.getAttribute("aria-label"), "Send");

      activity.push({
        seq: 5,
        parentSeq: null,
        type: "tool_result",
        createdAt: Date.now(),
        payload: { tool: "execute", callId: "c2", code: 130, result: "interrupted" },
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      h.visibleConversation().drawActiveChat();
      assert.equal(stoppingHeads().length, 1, "late tool results do not change the stop head");
      assert.equal(stoppingHeads()[0]!.textContent!.trim(), "Stopping…");
      assert.equal(fold()!.open, opened);

      ended = true;
      await until(() => /You stopped after/.test(main().textContent ?? ""));
      assert.equal(stopButton(), null);
      assert.doesNotMatch(main().textContent ?? "", /Stopping…|Stop requested/);
    } finally {
      await h.close();
    }
  });
