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

test("a live turn whose reply was retracted shows the retry reason as its current step", async () => {
  const startedAt = Date.now() - 6_000;
  const activity: unknown[] = [
    { seq: 0, parentSeq: null, type: "text_start", createdAt: startedAt, payload: { streamOffset: 0 } },
    {
      seq: 2,
      parentSeq: null,
      type: "text",
      createdAt: startedAt + 3000,
      payload: { text: "Here \u2014 a draft.", retracted: "em dash" },
    },
    { seq: 2, parentSeq: null, type: "text_start", createdAt: startedAt + 3100, payload: { streamOffset: 17 } },
  ];
  const run = () => ({
    status: "running",
    alive: true,
    startedAt,
    attempt: 1,
    activity,
    result: null,
    partial: "Here \u2014 a draft.\n\n",
  });
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    entries: [{ seq: 1, type: "user", createdAt: startedAt - 1000, payload: { text: "compare them" } }],
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
    await until(() => /Retrying: em dash/.test(head()?.textContent ?? ""));
    assert.doesNotMatch(document.querySelector(".work-said")?.textContent ?? "", /a draft/);
  } finally {
    await h.close();
  }
});

test("a finished reply shows the retracted draft as a collapsed stub above the new answer", async () => {
  const at = Date.now() - 60_000;
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    entries: [
      { seq: 1, type: "user", createdAt: at, payload: { text: "compare them" } },
      {
        seq: 2,
        type: "text",
        createdAt: at + 3000,
        payload: {
          text: "Here \u2014 a draft.",
          retracted: "em dash",
          step: { id: "s1", index: 0, api: "anthropic-messages", stopReason: "stop" },
        },
      },
      {
        seq: 3,
        type: "assistant",
        createdAt: at + 6000,
        payload: {
          text: "Here is a clean reply.",
          step: { id: "s2", index: 0, api: "anthropic-messages", stopReason: "stop" },
        },
      },
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => document.querySelector("details.retracted-reply") !== null);
    const stub = document.querySelector<HTMLDetailsElement>("details.retracted-reply")!;
    assert.equal(stub.open, false);
    assert.match(stub.querySelector("summary")!.textContent!, /Retracted: em dash/);
    const body = stub.querySelector(".retracted-body qm-markdown") as (Element & { content?: string }) | null;
    assert.match(body?.content ?? "", /a draft/);
    assert.equal(document.querySelectorAll("details.retracted-reply").length, 1);
    const rendered = [...document.querySelectorAll("details.retracted-reply, qm-markdown")].filter(
      (el) => !el.closest(".retracted-body") && !el.closest("details.work"),
    );
    const answerAt = rendered.findIndex((el) =>
      /clean reply/.test((el as Element & { content?: string }).content ?? ""),
    );
    assert.ok(answerAt > rendered.indexOf(stub), "the stub sits above the new answer");
  } finally {
    await h.close();
  }
});
