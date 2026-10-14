import assert from "node:assert/strict";
import test from "node:test";
import { browserEnv } from "./browser-env.ts";

for (const stored of [null, "1", "0", "unavailable"] as const) {
  test(`sidebar surface preference: ${stored ?? "fresh browser"}`, async () => {
    const sessions = [
      {
        id: "web",
        threadRef: "web:tester:one",
        scopeId: "personal:tester",
        title: "Web chat",
        canContinue: true,
        createdAt: 3,
      },
      {
        id: "slack",
        threadRef: "ch:C_TEAM:1700000000.000100",
        scopeId: "channel:C_TEAM",
        title: "Team chat",
        createdAt: 2,
      },
      { id: "child", threadRef: "web:tester:child", scopeId: "personal:tester", parentSessionId: "web", createdAt: 1 },
      {
        id: "archived",
        threadRef: "ch:C_TEAM:1699999999.000100",
        scopeId: "channel:C_TEAM",
        archived: true,
        createdAt: 0,
      },
    ];
    const env = await browserEnv({
      fetch: async (input) => {
        if (String(input) === "/api/sessions") return Response.json({ sessions });
        if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
        throw new Error(`Unexpected request: ${input}`);
      },
    });
    try {
      if (stored === "unavailable") {
        const getItem = localStorage.getItem.bind(localStorage);
        env.dom.window.Storage.prototype.getItem = (key: string) => {
          if (key === "web-ui:web-only") throw new Error("Storage unavailable");
          return getItem(key);
        };
      } else if (stored !== null) localStorage.setItem("web-ui:web-only", stored);
      const shell = await env.vite.ssrLoadModule("/src/shell.ts");
      const sidebar = await env.vite.ssrLoadModule("/src/sessions.ts");
      shell.appState.me = { user: "tester", org: "test", permissions: [] };
      shell.mountShell();
      await sidebar.refreshSessions();
      const rowIds = () =>
        [...document.querySelectorAll<HTMLElement>("#sidebar-body .session-row")].map((row) => row.dataset.sessionId);
      const slackRow = () => document.querySelector('[data-session-id="slack"]');
      assert.deepEqual(rowIds(), stored === "1" ? ["web"] : ["web", "slack"]);
      if (stored !== "1") {
        assert.ok(slackRow()?.querySelector(".slack-logo"));
        assert.match(slackRow()?.querySelector(".session")?.getAttribute("aria-label") ?? "", /slack/);
      }
      assert.equal(document.querySelector('[data-view="inbox"]'), null);
      assert.equal(document.querySelector('[data-view="calendar"]'), null);
      sidebar.setWebOnly(true);
      assert.deepEqual(rowIds(), ["web"]);
      sidebar.setWebOnly(false);
      assert.deepEqual(rowIds(), ["web", "slack"]);
      assert.ok(slackRow()?.querySelector(".slack-logo"));
      assert.equal(slackRow()?.querySelector(".ro-lock"), null);
      assert.match(slackRow()?.querySelector(".session")?.getAttribute("aria-label") ?? "", /read-only/);
      if (stored !== "unavailable") assert.equal(localStorage.getItem("web-ui:web-only"), "0");
    } finally {
      await env.close();
    }
  });
}
