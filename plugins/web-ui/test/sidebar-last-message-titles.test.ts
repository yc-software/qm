import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { browserEnv } from "./browser-env.ts";

function chat(id: string, title: string, createdAt: number, extra: Partial<CoreSession> = {}): CoreSession {
  return {
    id,
    threadRef: `web:tester:${id}`,
    scopeId: "personal:tester",
    type: "dm",
    title,
    createdAt,
    canContinue: true,
    ...extra,
  };
}

async function withSidebar(
  sessions: CoreSession[],
  fn: (
    row: (id: string) => { main?: string; detail: string | null; flagged: boolean },
    sidebar: { bumpSessionActivity: (threadRef: string, sent?: string) => void },
  ) => void,
): Promise<void> {
  const env = await browserEnv({
    fetch: async (input) => {
      if (String(input).startsWith("/api/sessions?")) return Response.json({ sessions });
      if (String(input) === "/api/contexts") return Response.json({ contexts: [] });
      throw new Error(`Unexpected request: ${input}`);
    },
  });
  try {
    const shell = await env.vite.ssrLoadModule("/src/shell.ts");
    const sidebar = await env.vite.ssrLoadModule("/src/sessions.ts");
    shell.appState.me = { user: "tester", org: "test", permissions: [] };
    shell.mountShell();
    await sidebar.refreshSessions();
    fn((id) => {
      const el = document.querySelector(`[data-session-id="${id}"]`);
      assert.ok(el, id);
      return {
        main: el.querySelector(".title .tl")?.textContent?.trim(),
        detail: el.querySelector(".row-detail")?.textContent?.trim() ?? null,
        flagged: el.classList.contains("last-message-title"),
      };
    }, sidebar as never);
  } finally {
    await env.close();
  }
}

test("rows without a last message preview keep today's title and layout", async () => {
  await withSidebar([chat("plain", "Quarterly plan", 3)], (row, sidebar) => {
    assert.deepEqual(row("plain"), { main: "Quarterly plan", detail: null, flagged: false });
    sidebar.bumpSessionActivity("web:tester:plain", "a new message");
    assert.deepEqual(row("plain"), { main: "Quarterly plan", detail: null, flagged: false });
  });
});

test("a last message preview becomes the row title with the old title beneath, falling back when empty", async () => {
  await withSidebar(
    [
      chat("talked", "Quarterly plan", 3, { lastUserPreview: "now tighten the intro please" }),
      chat("empty", "Named but empty", 2, { lastUserPreview: null }),
      chat("same", "fix the login bug", 1, { lastUserPreview: "fix the login bug" }),
    ],
    (row, sidebar) => {
      assert.deepEqual(row("talked"), {
        main: "now tighten the intro please",
        detail: "Quarterly plan",
        flagged: true,
      });
      assert.deepEqual(row("empty"), { main: "Named but empty", detail: null, flagged: false });
      assert.deepEqual(row("same"), { main: "fix the login bug", detail: null, flagged: false });
      sidebar.bumpSessionActivity("web:tester:empty", "what about Q3 hiring?");
      assert.deepEqual(row("empty"), { main: "what about Q3 hiring?", detail: "Named but empty", flagged: true });
    },
  );
});
