import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

const wire = (id: string) => ({ wire: { message: { id, api: "anthropic-messages", stopReason: "stop" } } });

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
    { marker: "text_start", seq: 0, createdAt: startedAt, streamOffset: 0 },
    {
      item: item("AgentMessage", {
        seq: 2,
        createdAt: startedAt + 3000,
        variant: "narration",
        text: "Here \u2014 a draft.",
        body: { retracted: "em dash" },
      }),
    },
    { marker: "text_start", seq: 2, createdAt: startedAt + 3100, streamOffset: 17 },
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
    items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "compare them" })],
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
    items: [
      item("UserMessage", { seq: 1, createdAt: at, text: "compare them" }),
      item("AgentMessage", {
        seq: 2,
        createdAt: at + 3000,
        variant: "narration",
        text: "Here \u2014 a draft.",
        step: 0,
        body: { retracted: "em dash", ...wire("s1") },
      }),
      item("AgentMessage", { seq: 3, createdAt: at + 6000, text: "Here is a clean reply.", step: 0, body: wire("s2") }),
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
    const body = stub.querySelector(".thinking-body qm-markdown") as (Element & { content?: string }) | null;
    assert.match(body?.content ?? "", /a draft/);
    assert.equal(document.querySelectorAll("details.retracted-reply").length, 1);
    const rendered = [...document.querySelectorAll("details.retracted-reply, qm-markdown")].filter(
      (el) => !el.closest(".retracted-reply") && !el.closest("details.work"),
    );
    const answerAt = rendered.findIndex((el) =>
      /clean reply/.test((el as Element & { content?: string }).content ?? ""),
    );
    assert.ok(answerAt > rendered.indexOf(stub), "the stub sits above the new answer");
  } finally {
    await h.close();
  }
});

test("a live turn the reply check prodded shows the reason as its current step", async () => {
  const startedAt = Date.now() - 6_000;
  const activity: unknown[] = [
    { marker: "text_start", seq: 0, createdAt: startedAt, streamOffset: 0 },
    {
      item: item("AgentMessage", {
        seq: 2,
        createdAt: startedAt + 3000,
        variant: "narration",
        text: "Core is busy. I haven't traced why.",
        body: { prodded: "unfinished" },
      }),
    },
    { marker: "text_start", seq: 2, createdAt: startedAt + 3100, streamOffset: 36 },
  ];
  const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity, result: null });
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "why is core hot?" })],
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
    await until(() => /Continuing: unfinished/.test(head()?.textContent ?? ""));
  } finally {
    await h.close();
  }
});

test("a finished prodded turn keeps the first reply as its own message, marked as continuing, above the final answer", async () => {
  const at = Date.now() - 60_000;

  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    items: [
      item("UserMessage", { seq: 1, createdAt: at, text: "why is core hot?" }),
      item("AgentMessage", {
        seq: 2,
        createdAt: at + 3000,
        variant: "narration",
        text: "Core is busy. I haven't traced why.",
        step: 0,
        body: { prodded: "unfinished", ...wire("s1") },
      }),
      item("Wake", {
        seq: 3,
        createdAt: at + 3100,
        wakeCause: "system",
        body: { text: "[system] The reply check says you stopped early." },
      }),
      item("AgentMessage", {
        seq: 4,
        createdAt: at + 9000,
        text: "Traced it: the sync loop holds the CPU.",
        step: 0,
        body: wire("s2"),
      }),
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => document.querySelector(".continuing-note") !== null);
    assert.equal(document.querySelectorAll(".continuing-note").length, 1);
    assert.match(document.querySelector(".continuing-note")!.textContent!, /Continuing: unfinished/);
    assert.equal(document.querySelectorAll("details.retracted-reply").length, 0);
    const replies = [...document.querySelectorAll("qm-markdown")]
      .map((el) => (el as Element & { content?: string }).content ?? "")
      .filter((c) => /traced|Traced/.test(c));
    assert.deepEqual(replies, ["Core is busy. I haven't traced why.", "Traced it: the sync loop holds the CPU."]);
    assert.doesNotMatch(document.body.textContent ?? "", /stopped early/);
  } finally {
    await h.close();
  }
});
