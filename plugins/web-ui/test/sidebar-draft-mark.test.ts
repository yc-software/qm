import assert from "node:assert/strict";
import test from "node:test";
import { browserEnv } from "./browser-env.ts";

test("sidebar rows mark conversations with an unsent draft", async () => {
  const sessions = [
    {
      id: "drafted",
      threadRef: "web:tester:drafted",
      scopeId: "personal:tester",
      surface: "web",
      title: "Drafted",
      createdAt: 3,
    },
    {
      id: "blank",
      threadRef: "web:tester:blank",
      scopeId: "personal:tester",
      surface: "web",
      title: "Blank",
      createdAt: 2,
    },
    {
      id: "plain",
      threadRef: "web:tester:plain",
      scopeId: "personal:tester",
      surface: "web",
      title: "Plain",
      createdAt: 1,
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
    localStorage.setItem(
      "web-ui:drafts",
      JSON.stringify([
        ["web:tester:drafted", "half-written thought"],
        ["web:tester:blank", "   "],
      ]),
    );
    const shell = await env.vite.ssrLoadModule("/src/shell.ts");
    const sidebar = await env.vite.ssrLoadModule("/src/sessions.ts");
    shell.appState.me = { user: "tester", org: "test", permissions: [] };
    shell.mountShell();
    await sidebar.refreshSessions();
    const mark = (id: string) => document.querySelector(`[data-session-id="${id}"] .draft-mark`);
    assert.ok(mark("drafted"), "a row with draft text shows the pen");
    assert.equal(mark("drafted")?.getAttribute("aria-label"), "Unsent draft");
    assert.equal(mark("blank"), null, "whitespace-only drafts don't count");
    assert.equal(mark("plain"), null, "rows without a draft stay clean");
  } finally {
    await env.close();
  }
});
