import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
};

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not settle`);
}

test("swarm worker read-only view streams live activity, goal progress, swarm strip, and follow-up runs", async () => {
  const startedAt = Date.now() - 2000;
  const session = {
    ...SESSION,
    type: "dm" as const,
    createdAt: startedAt - 1000,
    threadRef: "swarm:root:worker1",
    surface: "swarm",
    title: "Swarm worker 79d954bf",
    canContinue: false,
    working: true,
    workingSince: startedAt,
  };
  const call = (seq: number, callId: string, purpose: string) =>
    item("ToolCall", { seq, createdAt: startedAt + seq * 100, tool: "execute", callId, body: { purpose } });
  const [c1, c2, c3] = [call(1, "c1", "Initial"), call(2, "c2", "Live output"), call(4, "c3", "Follow-up step")];
  const goal = { objective: "Verify candidates", status: "active" as const, createdAt: startedAt, floor: "10m" };
  let items = [c1];
  let phase: "run1" | "idle" | "run2" | "done" = "run1";
  const [run1, run2] = [deferred(), deferred()];
  const finish = (reply: string) => Response.json({ status: "done", startedAt, result: { status: "ok", reply } });

  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    items,
    api: (path) => {
      if (path.includes("/api/runs/active")) {
        if (phase === "run1")
          return Response.json({
            runId: "r1",
            run: {
              status: "running",
              startedAt,
              alive: true,
              goal,
              activity: [{ item: c1 }, { item: c2 }],
              partial: "Live findings",
            },
            queued: [],
          });
        if (phase === "run2")
          return Response.json({
            runId: "r2",
            run: { status: "running", startedAt: Date.now(), alive: true, goal, activity: [{ item: c3 }] },
            queued: [],
          });
        return Response.json({ runId: null, run: null, queued: [] });
      }
      if (path.endsWith("/events")) return new Response(null, { status: 404 });
      if (path === "/api/runs/r1")
        return (phase === "run1" ? run1.promise : Promise.resolve()).then(() => finish("First summary"));
      if (path === "/api/runs/r2")
        return (phase === "run2" ? run2.promise : Promise.resolve()).then(() => finish("Second summary"));
      if (path === `/api/sessions/${session.id}/swarm`) {
        const self = {
          id: "79d954bf",
          parentId: "root",
          sessionId: session.id,
          sessionUrl: `/s/${session.id}`,
          state: "ready",
          depth: 1,
        };
        return Response.json({
          id: "root",
          self,
          peers: [{ id: "root", sessionId: "r0", sessionUrl: "/s/r0", state: "ready", depth: 0 }, self],
        });
      }
      if (path.startsWith(`/api/sessions/${session.id}`) && !path.includes("/approvals"))
        return Response.json({ session, items, earlierItems: 0, goal });
      return undefined;
    },
  });

  try {
    h.releaseSessions();
    await h.boot();
    await until(() => h.mainText().includes("Live output") && h.mainText().includes("Live findings"), "live streaming");
    assert.equal(document.querySelector("textarea"), null);
    assert.equal(document.querySelector(".fork-btn"), null);
    const goalEl = document.querySelector(".goal-strip");
    assert.match(goalEl?.textContent ?? "", /Verify candidates/);
    assert.equal(goalEl?.querySelector("button"), null);
    await until(() => Boolean(document.querySelector(".swarm-activity")), "swarm strip");

    phase = "idle";
    items = [c1, c2, item("AgentMessage", { seq: 3, createdAt: Date.now(), text: "First summary" })];
    run1.resolve();
    await until(
      () => h.mainText().includes("First summary") && !h.visibleConversation().state.agent?.state.isStreaming,
      "first summary",
    );

    phase = "run2";
    h.visibleConversation().resumeIfIdle();
    await until(() => h.mainText().includes("Follow-up step"), "follow-up run");
    phase = "done";
    items = [...items, c3, item("AgentMessage", { seq: 5, createdAt: Date.now(), text: "Second summary" })];
    run2.resolve();
    await until(() => h.mainText().includes("Second summary"), "second summary");
  } finally {
    run1.resolve();
    run2.resolve();
    await h.close();
  }
});
