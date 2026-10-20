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
        surface: "web",
        title: "Web chat",
        canContinue: true,
        createdAt: 3,
      },
      {
        id: "slack",
        threadRef: "ch:C_TEAM:1700000000.000100",
        scopeId: "channel:C_TEAM",
        surface: "slack",
        title: "Team chat",
        createdAt: 2,
      },
      {
        id: "group",
        threadRef: "grp:C_PRIVATE:1700000000.000200",
        scopeId: "channel:C_PRIVATE",
        surface: "slack",
        title: "Private channel thread",
        createdAt: 1.5,
      },
      {
        id: "cron-run",
        threadRef: "cron:c1:fire:abc",
        scopeId: "personal:tester",
        surface: "cron",
        createdAt: 5,
      },
      {
        id: "webhook-run",
        threadRef: "agent:main:webhook:w1",
        scopeId: "personal:tester",
        surface: "webhook",
        createdAt: 4,
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
        if (String(input).startsWith("/api/sessions?")) return Response.json({ sessions });
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
      const groupRow = () => document.querySelector('[data-session-id="group"]');
      assert.deepEqual(rowIds(), stored === "1" ? ["web"] : ["web", "slack", "group"]);
      if (stored !== "1") {
        assert.ok(slackRow()?.querySelector(".slack-mark"));
        assert.ok(groupRow()?.querySelector(".slack-mark"));
        assert.match(slackRow()?.querySelector(".session")?.getAttribute("aria-label") ?? "", /slack/);
      }
      assert.equal(document.querySelector('[data-view="inbox"]'), null);
      assert.equal(document.querySelector('[data-view="calendar"]'), null);
      sidebar.setWebOnly(true);
      await sidebar.refreshSessions();
      assert.deepEqual(rowIds(), ["web"]);
      sidebar.revealSessionSurface(sessions.find((s) => s.id === "cron-run"));
      assert.equal(sidebar.sessionsState.webOnly, true);
      sidebar.setWebOnly(false);
      await sidebar.refreshSessions();
      assert.deepEqual(rowIds(), ["web", "slack", "group"]);
      assert.ok(slackRow()?.querySelector(".slack-mark"));
      assert.equal(slackRow()?.querySelector(".ro-lock"), null);
      assert.doesNotMatch(slackRow()?.querySelector(".session")?.getAttribute("aria-label") ?? "", /read-only/);
      if (stored !== "unavailable") assert.equal(localStorage.getItem("web-ui:web-only"), "0");
    } finally {
      await env.close();
    }
  });
}
