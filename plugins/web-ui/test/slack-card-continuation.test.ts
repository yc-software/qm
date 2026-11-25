import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { harness, runtimeConfig, SESSION, settle } from "./deep-link-boot-fixture.ts";

test("the Add to Slack card continues the chat itself only when the install service completed the install", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    session: { ...SESSION, type: "dm", createdAt: 1 },
    items: [
      item("ToolCall", { seq: 1, createdAt: 1, tool: "card", callId: "c1", body: { kind: "add_to_slack" } }),
      item("ToolResult", {
        seq: 2,
        createdAt: 1,
        tool: "card",
        callId: "c1",
        body: { display: { kind: "add_to_slack" } },
      }),
      item("AgentMessage", { seq: 3, createdAt: 1, text: "Add QM to Slack below." }),
    ],
  });
  const originalFetch = globalThis.fetch;
  const turns: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/runtime-config") return Response.json(runtimeConfig);
    if (url.pathname !== "/api/turn") return originalFetch(input, init);
    turns.push(String(init?.body));
    return Response.json({ runId: "continuation-test", sessions: [] });
  };
  try {
    await h.boot();
    await settle(() => document.querySelector("qm-onboarding-welcome") !== null);
    const card = document.querySelector("qm-onboarding-welcome")!;
    const installed = (byService: boolean) =>
      card.dispatchEvent(new window.CustomEvent("slack-installed", { bubbles: true, detail: { byService } }));
    installed(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(turns.length, 0, "an install core already woke for sends nothing from the chat");
    installed(true);
    await settle(() => turns.length > 0);
    assert.equal(turns.length, 1);
    assert.match(turns[0]!, /I connected QM to our Slack workspace\. Please continue\./);
  } finally {
    globalThis.fetch = originalFetch;
    await h.close();
  }
});
