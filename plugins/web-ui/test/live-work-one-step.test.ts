import type { RunActivityEntry } from "../src/items.ts";
import { item } from "./item-fixture.ts";
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
  const activity: RunActivityEntry[] = [
    {
      item: item("ToolCall", {
        seq: 2,
        createdAt: startedAt,
        tool: "files",
        callId: "c1",
        body: { action: "read", path: "docs/plan.md" },
      }),
    },
    {
      item: item("ToolResult", {
        seq: 3,
        createdAt: startedAt + 1000,
        tool: "files",
        callId: "c1",
        body: { action: "read", path: "docs/plan.md", bytes: 10 },
      }),
    },
    {
      item: item("ToolCall", {
        seq: 4,
        createdAt: startedAt + 2000,
        tool: "execute",
        callId: "c2",
        body: { command: "npm test", purpose: "Run the test suite" },
      }),
    },
  ];
  const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity, result: null });
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "run the tests" })],
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
    assert.doesNotMatch(head()!.textContent!, /Working for|Reading files|Running commands/);
    assert.match(head()!.querySelector(".work-elapsed")?.textContent ?? "", /\d+s/);
    assert.ok(head()!.querySelector(".work-step .tool-icon svg"), "the step's icon sits left of the label");

    fold.open = true;
    fold.dispatchEvent(new Event("toggle"));
    h.visibleConversation().drawActiveChat();
    assert.equal((head()!.parentElement as HTMLDetailsElement).open, true, "user-opened fold stays open on redraw");
    assert.ok(document.querySelectorAll("details.work .tool-row").length >= 2, "expanded fold lists every step");

    activity.push(
      {
        item: item("ToolResult", {
          seq: 5,
          createdAt: startedAt + 3000,
          tool: "execute",
          callId: "c2",
          text: "ok",
          body: { code: 0 },
        }),
      },
      {
        item: item("ToolCall", {
          seq: 6,
          createdAt: startedAt + 4000,
          tool: "execute",
          callId: "c3",
          body: { command: "git diff --stat", purpose: "Measure the diff" },
        }),
      },
    );
    await until(() => /Measure the diff/.test(head()?.textContent ?? ""));
    const fading = head()!.querySelector(".work-step-label .work-step-out");
    assert.match(fading?.textContent ?? "", /Run the test suite/, "the previous label fades out on top of the new one");
    assert.equal(head()!.querySelector(".work-step-icon .work-step-out"), null, "an unchanged icon does not roll");
    assert.ok(head()!.querySelector(".work-step.work-step-enter-still"));
    await until(() => !head()!.querySelector(".work-step-out"));
    assert.doesNotMatch(head()!.textContent!, /Run the test suite/);

    activity.push(
      {
        item: item("ToolResult", {
          seq: 7,
          createdAt: startedAt + 5000,
          tool: "execute",
          callId: "c3",
          text: "ok",
          body: { code: 0 },
        }),
      },
      {
        item: item("ToolCall", {
          seq: 8,
          createdAt: startedAt + 6000,
          tool: "files",
          callId: "c4",
          body: { action: "read", path: "docs/notes.md" },
        }),
      },
    );
    await until(() => /notes\.md/.test(head()?.textContent ?? ""));
    assert.ok(head()!.querySelector(".work-step.work-step-enter-roll"), "a new icon rolls in");
    assert.ok(head()!.querySelector(".work-step-icon .work-step-out svg"), "the old icon rolls out beside it");
    assert.match(head()!.querySelector(".work-step-label .work-step-out")?.textContent ?? "", /Measure the diff/);
    await until(() => !head()!.querySelector(".work-step-out"));
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
    items: [
      item("UserMessage", { seq: 1, createdAt: startedAt - 60_000, text: "check the tests" }),
      item("ToolCall", {
        seq: 2,
        createdAt: startedAt - 59_000,
        tool: "execute",
        callId: "p1",
        body: { command: "npm test", purpose: "Run the test suite" },
      }),
      item("ToolResult", {
        seq: 3,
        createdAt: startedAt - 50_000,
        tool: "execute",
        callId: "p1",
        text: "ok",
        body: { code: 0 },
      }),
      item("ToolCall", {
        seq: 31,
        createdAt: startedAt - 50_000,
        tool: "files",
        callId: "p2",
        body: { action: "read", path: "docs/plan.md" },
      }),
      item("ToolResult", {
        seq: 32,
        createdAt: startedAt - 49_500,
        tool: "files",
        callId: "p2",
        body: { action: "read", path: "docs/plan.md", bytes: 10 },
      }),
      item("AgentMessage", {
        seq: 4,
        createdAt: startedAt - 49_000,
        variant: "narration",
        text: "All green.",
        body: { wire: { message: { stopReason: "stop" } } },
      }),
      item("UserMessage", { seq: 5, createdAt: startedAt - 1000, text: "testing" }),
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

test("text the agent says mid-turn stays visible between work folds while the live fold is closed", async () => {
  const startedAt = Date.now() - 12_000;
  const activity: RunActivityEntry[] = [
    {
      item: item("ToolCall", {
        seq: 2,
        createdAt: startedAt,
        tool: "files",
        callId: "c1",
        body: { action: "read", path: "docs/plan.md" },
      }),
    },
    {
      item: item("ToolResult", {
        seq: 3,
        createdAt: startedAt + 1000,
        tool: "files",
        callId: "c1",
        body: { action: "read", path: "docs/plan.md", bytes: 10 },
      }),
    },
    {
      item: item("AgentMessage", {
        seq: 4,
        createdAt: startedAt + 1500,
        variant: "narration",
        text: "Understood, fanning out.",
        body: { phase: "commentary" },
      }),
    },
    {
      item: item("ToolCall", {
        seq: 5,
        createdAt: startedAt + 2000,
        tool: "execute",
        callId: "c2",
        body: { command: "npm test", purpose: "Run the test suite" },
      }),
    },
  ];
  const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity, result: null });
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "find bugs" })],
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
    const folds = () => [...document.querySelectorAll<HTMLDetailsElement>("details.work")];
    await until(() =>
      folds().some((fold) => /Run the test suite/.test(fold.querySelector("summary")?.textContent ?? "")),
    );
    const said = [...document.querySelectorAll<HTMLElement>(".streaming-text")].find((el) =>
      /Understood, fanning out\./.test(
        el.querySelector<HTMLElement & { content: string }>("qm-markdown")?.content ?? "",
      ),
    );
    assert.ok(said, "the mid-turn text is drawn");
    assert.equal(said.closest("details"), null, "the mid-turn text sits outside every fold");
    const live = folds().at(-1)!;
    assert.equal(live.open, false, "the live fold stays closed");
    assert.equal(live.querySelector("qm-markdown, .work-said"), null, "the live fold does not repeat the text");
    assert.ok(
      said.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the text sits above the step that came after it",
    );
  } finally {
    await h.close();
  }
});

test("a thinking row reads Thought once later work follows it, and Thinking only while it is the live tail", async () => {
  const startedAt = Date.now() - 5_000;
  const thought = item("Reasoning", {
    seq: 2,
    createdAt: startedAt + 100,
    text: "Check the docs first.",
    body: { wire: { step: "s1", index: 0 } },
  });
  const followed: RunActivityEntry[] = [
    { item: thought },
    {
      item: item("AgentMessage", {
        seq: 3,
        createdAt: startedAt + 200,
        variant: "narration",
        text: "Starting the rest now.",
        body: { wire: { message: { stopReason: "toolUse" } } },
      }),
    },
    {
      item: item("ToolCall", {
        seq: 4,
        createdAt: startedAt + 300,
        tool: "execute",
        callId: "c1",
        body: { command: "npm test", purpose: "Rechecking docs publish" },
      }),
    },
  ];
  for (const [activity, title] of [
    [followed, "Thought"],
    [[{ item: thought }], "Thinking"],
  ] as const) {
    const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity, result: null });
    const h = await harness({
      path: `/s/${SESSION.id}`,
      listSessions: [SESSION],
      items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "did you do that?" })],
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
      const titles = () => [...document.querySelectorAll(".thinking-title")].map((el) => el.textContent);
      await until(() => titles().length > 0);
      assert.deepEqual(titles(), [title]);
    } finally {
      await h.close();
    }
  }
});
