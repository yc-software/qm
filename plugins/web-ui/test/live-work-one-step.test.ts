import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("a live turn shows only the current step in a closed fold that remembers being opened", async () => {
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
  const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity, result: null });
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    entries: [{ seq: 1, type: "user", createdAt: startedAt - 1000, payload: { text: "run the tests" } }],
    api: (path) => {
      if (path.includes("/api/runs/active")) return Response.json({ runId: "r1", run: run(), queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json(run());
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const head = () => document.querySelector<HTMLElement>("details.work > summary.work-head");
    await until(() => /Run the test suite/.test(head()?.textContent ?? ""));
    const fold = head()!.parentElement as HTMLDetailsElement;
    assert.equal(fold.open, false, "live fold starts closed");
    assert.match(head()!.textContent!, /Run the test suite/);
    assert.doesNotMatch(head()!.textContent!, /Working for|Read files|Running commands/);
    assert.match(head()!.querySelector(".work-elapsed")?.textContent ?? "", /\d+s/);

    fold.open = true;
    fold.dispatchEvent(new Event("toggle"));
    h.visibleConversation().drawActiveChat();
    assert.equal((head()!.parentElement as HTMLDetailsElement).open, true, "user-opened fold stays open on redraw");
    assert.ok(document.querySelectorAll("details.work .tool-row").length >= 2, "expanded fold lists every step");

    activity.push(
      {
        seq: 5,
        parentSeq: null,
        type: "tool_result",
        createdAt: startedAt + 3000,
        payload: { tool: "execute", callId: "c2", code: 0, result: "ok" },
      },
      {
        seq: 6,
        parentSeq: null,
        type: "tool_call",
        createdAt: startedAt + 4000,
        payload: { tool: "execute", callId: "c3", command: "git diff --stat", purpose: "Measure the diff" },
      },
    );
    await until(() => /Measure the diff/.test(head()?.textContent ?? ""));
    assert.doesNotMatch(head()!.textContent!, /Run the test suite/);
  } finally {
    await h.close();
  }
});
