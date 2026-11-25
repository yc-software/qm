import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";
import type { Item } from "../src/items.ts";

const text = "Connect Drive first.";
const at = Date.now() - 6_000;
const user = item("UserMessage", { seq: 1, createdAt: at, text: "read my drive" });
const card = (isError: boolean) => [
  item("ToolCall", {
    seq: 2,
    createdAt: at,
    tool: "card",
    callId: "c1",
    body: { kind: "apps", toolkit: "googledrive" },
  }),
  item("ToolResult", {
    seq: 3,
    createdAt: at,
    tool: "card",
    callId: "c1",
    isError,
    body: isError ? { error: "No connectable app" } : { display: { kind: "apps", toolkit: "googledrive" } },
  }),
];
const post = [
  item("ToolCall", { seq: 4, createdAt: at, tool: "web", callId: "p", body: { action: "post", text } }),
  item("ToolResult", { seq: 5, createdAt: at, tool: "web", callId: "p", body: { ok: true } }),
];
const live = (activity: Item[]) => {
  const run = {
    status: "running",
    alive: true,
    startedAt: at,
    attempt: 1,
    activity: activity.map((i) => ({ item: i })),
  };
  return (path: string) => {
    if (path.includes("/api/runs/active")) return Response.json({ runId: "r1", run, queued: [] });
    if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
    if (path === "/api/runs/r1") return Response.json(run);
    return undefined;
  };
};
const cases: Record<string, { items: Item[]; api?: (path: string) => Response | undefined; shown: string[][] }> = {
  "a finished turn": { items: [user, ...card(false), ...post], shown: [["googledrive", "card:c1"]] },
  "a live turn": { items: [user], api: live([...card(false), ...post]), shown: [["googledrive", "card:c1"]] },
  "a failed card call": { items: [user, ...card(true), ...post], shown: [] },
};

for (const [name, { items, api, shown }] of Object.entries(cases))
  test(`the card tool's result in ${name} renders only cards that passed their check`, async () => {
    const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], items, api });
    try {
      h.releaseSessions();
      await h.boot();
      await h.sessionsReady();
      const cards = () => [
        ...document.querySelectorAll<Element & { toolkit?: string; returnKey?: string }>("qm-onboarding-welcome"),
      ];
      const said = () =>
        [...document.querySelectorAll<Element & { content?: string }>("qm-markdown")].some((el) =>
          el.content?.includes(text),
        );
      for (let i = 0; i < 300 && !(said() && cards().length === shown.length); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(said());
      assert.deepEqual(
        cards().map((card) => [card.toolkit, card.returnKey]),
        shown,
      );
    } finally {
      await h.close();
    }
  });
