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
    assert.ok(head()!.querySelector(".work-step .tool-icon svg"), "the step's icon sits left of the label");

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
    const fading = head()!.querySelector(".work-step-out");
    assert.match(fading?.textContent ?? "", /Run the test suite/, "the previous step fades out on top of the new one");
    await until(() => !head()!.querySelector(".work-step-out"));
    assert.doesNotMatch(head()!.textContent!, /Run the test suite/);
  } finally {
    await h.close();
  }
});

test("a step-less live turn draws one Thinking line that redraws of earlier work heads never animate", async () => {
  const startedAt = Date.now() - 3_000;
  const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity: [], result: null });
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    entries: [
      { seq: 1, type: "user", createdAt: startedAt - 60_000, payload: { text: "check the tests" } },
      {
        seq: 2,
        type: "tool_call",
        createdAt: startedAt - 59_000,
        payload: { tool: "execute", callId: "p1", command: "npm test", purpose: "Run the test suite" },
      },
      {
        seq: 3,
        type: "tool_result",
        createdAt: startedAt - 50_000,
        payload: { tool: "execute", callId: "p1", code: 0, result: "ok" },
      },
      {
        seq: 31,
        type: "tool_call",
        createdAt: startedAt - 50_000,
        payload: { tool: "files", action: "read", callId: "p2", path: "docs/plan.md" },
      },
      {
        seq: 32,
        type: "tool_result",
        createdAt: startedAt - 49_500,
        payload: { tool: "files", action: "read", callId: "p2", path: "docs/plan.md", bytes: 10 },
      },
      {
        seq: 4,
        type: "text",
        createdAt: startedAt - 49_000,
        payload: { text: "All green.", step: { stopReason: "stop" } },
      },
      { seq: 5, type: "user", createdAt: startedAt - 1000, payload: { text: "testing" } },
    ],
    api: (path) => {
      if (path.includes("/api/runs/active")) return Response.json({ runId: "r1", run: run(), queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json(run());
      return undefined;
    },
  });
  const animateBefore = Element.prototype.animate;
  let animations = 0;
  Element.prototype.animate = function () {
    animations++;
    return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
  };
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const prestep = () => document.querySelector<HTMLElement>(".work-prestep .work-step");
    await until(() => /Thinking/.test(prestep()?.textContent ?? ""));
    assert.match(document.querySelector("details.work:not(.work-prestep) > summary")?.textContent ?? "", /Worked for/);
    assert.equal(document.querySelector(".live-work-line"), null, "no second status line below the transcript");
    for (let i = 0; i < 3; i++) {
      h.visibleConversation().drawActiveChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(animations, 0, "redraws with an earlier finished work head do not animate the live line");
  } finally {
    Element.prototype.animate = animateBefore;
    await h.close();
  }
});
