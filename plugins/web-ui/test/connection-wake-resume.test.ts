import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

const at = Date.now() - 6_000;
const earlier = [
  item("UserMessage", { seq: 1, createdAt: at, turnId: "r0", text: "read my drive" }),
  item("ToolCall", { seq: 2, createdAt: at, turnId: "r0", tool: "card", callId: "c1", body: { kind: "apps" } }),
  item("ToolResult", {
    seq: 3,
    createdAt: at,
    turnId: "r0",
    tool: "card",
    callId: "c1",
    body: { display: { kind: "apps", toolkit: "googledrive" } },
  }),
  item("AgentMessage", { seq: 4, createdAt: at, turnId: "r0", text: "Connect Drive first." }),
  item("UserMessage", { seq: 5, createdAt: at, turnId: "r1", hidden: true, text: "<wake/>" }),
];
const step = item("ToolCall", { seq: 6, createdAt: at, turnId: "r1", tool: "execute", callId: "x", body: {} });
const run = { status: "running", alive: true, startedAt: at, attempt: 1, activity: [{ item: step }] };
const api = (path: string) => {
  if (path.includes("/api/runs/active")) return Response.json({ runId: "r1", run, queued: [] });
  if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
  if (path === "/api/runs/r1") return Response.json(run);
  return undefined;
};

const idle = { ...SESSION, type: "dm" as const, createdAt: at };
for (const [name, session] of Object.entries({
  "started after the page loaded": idle,
  "already running at page load": { ...idle, working: true, workingSince: at, workingRun: "r1" },
}))
  test(`a wake turn ${name} leaves the earlier reply and its card in place and works below them`, async () => {
    const h = await harness({ path: `/s/${SESSION.id}`, session, listSessions: [session], items: earlier, api });
    try {
      h.releaseSessions();
      await h.boot();
      await h.sessionsReady();
      const working = () => document.querySelector(".assistant-row.streaming");
      for (let i = 0; i < 300 && !working(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const rows = [...document.querySelectorAll(".assistant-row")];
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.querySelectorAll("qm-onboarding-welcome").length, 1);
      assert.equal(
        rows[0]!.querySelector<Element & { content?: string }>("qm-markdown")?.content,
        "Connect Drive first.",
      );
      assert.equal(rows[1], working());
    } finally {
      await h.close();
    }
  });
