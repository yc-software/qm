import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";
import type { Item } from "../src/items.ts";

const text = 'Connect Drive first.\n\n::connect-apps{toolkit="googledrive"}';
const at = Date.now() - 6_000;
const wire = (stopReason: string) => ({ wire: { message: { id: stopReason, api: "anthropic-messages", stopReason } } });
const user = item("UserMessage", { seq: 1, createdAt: at, text: "read my drive" });
const post = [
  item("ToolCall", { seq: 2, createdAt: at, tool: "web", callId: "p", body: { action: "post", text } }),
  item("ToolResult", { seq: 3, createdAt: at, tool: "web", callId: "p", body: { ok: true } }),
];
const run = { status: "running", alive: true, startedAt: at, attempt: 1, activity: post.map((i) => ({ item: i })) };
const cases: Record<string, { key: string; items: Item[]; api?: (path: string) => Response | undefined }> = {
  "a finished turn's posted reply": { key: `reply:${at}:0:1`, items: [user, ...post] },
  "a finished turn's narration": {
    key: "said:text:2:1",
    items: [
      user,
      item("AgentMessage", { seq: 2, createdAt: at, variant: "narration", text, step: 0, body: wire("toolUse") }),
      item("AgentMessage", { seq: 3, createdAt: at, text: "Waiting on you.", step: 1, body: wire("stop") }),
    ],
  },
  "a live turn's posted reply": {
    key: `reply:${at}:0:1`,
    items: [user],
    api: (path: string) => {
      if (path.includes("/api/runs/active")) return Response.json({ runId: "r1", run, queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json(run);
      return undefined;
    },
  },
};

for (const [name, { key, items, api }] of Object.entries(cases))
  test(`a connect directive in ${name} renders the connect card`, async () => {
    const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], items, api });
    try {
      h.releaseSessions();
      await h.boot();
      await h.sessionsReady();
      const cards = () => [
        ...document.querySelectorAll<Element & { toolkit?: string; returnKey?: string }>("qm-onboarding-welcome"),
      ];
      for (let i = 0; i < 300 && !cards().length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(
        cards().map((card) => [card.toolkit, card.returnKey]),
        [["googledrive", key]],
      );
      const shown = [...document.querySelectorAll<Element & { content?: string }>("qm-markdown")].map(
        (el) => el.content,
      );
      assert.ok(shown.includes("Connect Drive first.\n\n"));
      assert.ok(shown.every((content) => !content?.includes("::connect-apps")));
    } finally {
      await h.close();
    }
  });
