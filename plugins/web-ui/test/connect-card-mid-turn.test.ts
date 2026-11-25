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

test("several cards from one turn each keep their own app after the turn settles", async () => {
  const apps = { gmail: "Gmail", googledrive: "Google Drive", notion: "Notion" };
  const calls = Object.keys(apps).flatMap((toolkit, i) => [
    item("ToolCall", { seq: 2 + i * 2, createdAt: at, tool: "card", callId: `c${i}`, body: { kind: "apps", toolkit } }),
    item("ToolResult", {
      seq: 3 + i * 2,
      createdAt: at,
      tool: "card",
      callId: `c${i}`,
      body: { display: { kind: "apps", toolkit } },
    }),
  ]);
  const reply = [
    item("ToolCall", { seq: 8, createdAt: at, tool: "web", callId: "p", body: { action: "post", text } }),
    item("ToolResult", { seq: 9, createdAt: at, tool: "web", callId: "p", body: { ok: true } }),
  ];
  const items: Item[] = [user];
  let run: Record<string, unknown> = {
    status: "running",
    alive: true,
    startedAt: at,
    attempt: 1,
    activity: calls.map((i) => ({ item: i })),
  };
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    items,
    api: (path) => {
      if (path.startsWith("/api/composio/toolkits")) {
        const asked = new URL(path, "http://localhost").searchParams.get("toolkit") ?? "";
        const listed = Object.entries(apps).map(([id, name]) => ({ id, name }));
        return Response.json({ items: listed.filter((app) => !asked || app.id === asked), nextCursor: null });
      }
      if (path.includes("/api/runs/active"))
        return Response.json(run.alive ? { runId: "r1", run, queued: [] } : { runId: null, run: null, queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json(run);
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const shown = () =>
      [...document.querySelectorAll("qm-onboarding-welcome")].map((card) => card.textContent?.replace(/\s+/g, " "));
    const each = () => {
      const texts = shown();
      return texts.length === 3 && Object.values(apps).every((name, i) => texts[i]?.includes(name));
    };
    const said = () =>
      [...document.querySelectorAll<Element & { content?: string }>("qm-markdown")].some((el) =>
        el.content?.includes(text),
      );
    for (let i = 0; i < 300 && !each(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(each(), JSON.stringify(shown()));
    items.push(...calls, ...reply);
    run = { status: "done", alive: false, startedAt: at, attempt: 1, result: { status: "ok", reply: text } };
    for (let i = 0; i < 300 && !said(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(said());
    assert.ok(each(), JSON.stringify(shown()));
  } finally {
    await h.close();
  }
});
