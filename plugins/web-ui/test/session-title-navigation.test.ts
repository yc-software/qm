import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSessionNavigation,
  projectSessionPage,
  resolveSessionReferences,
} from "../../../src/api/session-navigation.ts";
import type { Session } from "../../../src/types.ts";
import { harness } from "./deep-link-boot-fixture.ts";

const session = (id: string, title: string): Session => ({
  id,
  title,
  threadRef: `web:tester:${id}`,
  scopeId: "personal:tester",
  type: "dm",
  createdAt: 1,
});
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), document.querySelector(".main")?.textContent?.slice(0, 3000));
};

test("title-only tool chips resolve on activation beyond fifty substring matches and report missing/error honestly", async () => {
  const root = session("root", "Root");
  const title = "Exact target";
  const exact = {
    ...session("off-page", title),
    parentSessionId: root.id,
    archived: true,
    threadRef: "agent:main:subagent:off-page",
  };
  const searchTarget = { ...session("search-off-page", "Search destination"), archived: true };
  const rows = [
    searchTarget,
    root,
    ...Array.from({ length: 65 }, (_, i) => session(`distractor-${i}`, `${title} ${i}`)),
    exact,
  ];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let pageStatus = 200;
  const entries = [
    { seq: 0, type: "user", createdAt: 1, payload: { text: "Inspect children" } },
    ...[title, "unknown", "denied"].flatMap((target, i) => [
      {
        seq: i * 2 + 1,
        type: "tool_call",
        createdAt: i + 2,
        payload: { tool: "sessions", action: "read", target, callId: `c${i}` },
      },
      {
        seq: i * 2 + 2,
        parentSeq: i * 2 + 1,
        type: "tool_result",
        createdAt: i + 2,
        payload: { tool: "sessions", action: "read", callId: `c${i}`, title: target },
      },
    ]),
  ];
  const h = await harness({
    path: "/s/root",
    session: root,
    listSessions: rows,
    entries,
    onRequest: (path, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (path.startsWith("/api/session-navigation")) requests.push({ path, body });
      if (path === "/api/session-navigation")
        return Response.json(projectSessionNavigation(rows, rows, [], "tester", body));
      if (path === "/api/session-navigation/page") {
        if (pageStatus !== 200) return Response.json({ error: "denied" }, { status: pageStatus });
        return Response.json(projectSessionPage(rows, [], body));
      }
      if (path === "/api/session-navigation/resolve")
        return Response.json(resolveSessionReferences(rows, body.references));
      if (path.startsWith("/api/search?"))
        return Response.json({
          hits: [
            {
              sessionId: searchTarget.id,
              title: searchTarget.title,
              scopeId: searchTarget.scopeId,
              seq: 0,
              entryType: "user",
              snippet: "Found outside loaded pages",
              createdAt: 1,
            },
          ],
        });
      if (path.startsWith("/api/resources/search")) return Response.json({ hits: [], failed: [] });
      return undefined;
    },
  });
  const chip = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button.subagent-chip")].find(
      (button) => button.textContent?.trim() === text,
    );
  try {
    await h.boot();
    await waitFor(() => Boolean(chip(title)));
    assert.equal(
      requests.some((request) => request.body.title !== undefined),
      false,
    );
    chip(title)!.dispatchEvent(new Event("pointerenter"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      requests.some((request) => request.body.title !== undefined),
      false,
    );
    chip(title)!.click();
    await waitFor(() => h.visibleConversation().state.sessionId === exact.id);
    assert.deepEqual(requests.find((request) => request.body.title === title)!.body, { title, children: true });
    assert.equal(h.requests.includes("/api/sessions"), false);
    await h.openSession(root);
    await waitFor(() => Boolean(chip("unknown")));
    chip("unknown")!.click();
    await waitFor(() => h.mainText().includes("Couldn't open that session."));
    assert.equal(h.visibleConversation().state.sessionId, root.id);
    pageStatus = 403;
    chip("denied")!.click();
    await waitFor(() => requests.some((request) => request.body.title === "denied"));
    assert.equal(h.visibleConversation().state.sessionId, root.id);
    assert.equal(h.requests.includes("/api/sessions"), false);
    assert.equal(
      h.sessionsState.list.some((row) => row.id === searchTarget.id),
      false,
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Search"]')!.click();
    const search = document.querySelector<HTMLInputElement>(".chat-search-input")!;
    search.value = "off-page";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() =>
      [...document.querySelectorAll(".chat-search-row")].some((row) =>
        row.textContent?.includes("Found outside loaded pages"),
      ),
    );
    const hit = [...document.querySelectorAll<HTMLButtonElement>(".chat-search-row")].find((row) =>
      row.textContent?.includes("Found outside loaded pages"),
    )!;
    hit.click();
    await waitFor(() => h.visibleConversation().state.sessionId === searchTarget.id);
    assert.equal(h.requests.filter((path) => path.startsWith(`/api/sessions/${searchTarget.id}?`)).length, 1);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});

for (const phase of ["title", "transcript"] as const) {
  for (const status of [200, 403]) {
    test(`title activation ignores late ${phase} ${status} after leaving Chats`, async () => {
      const root = { ...session("root", "Root"), lastActivityAt: 100 };
      const child = { ...session("child", "Exact child"), parentSessionId: root.id, lastActivityAt: 1 };
      const rows = [root, child];
      const entries = [
        { seq: 0, type: "user", createdAt: 1, payload: { text: "" } },
        {
          seq: 1,
          type: "tool_call",
          createdAt: 2,
          payload: { tool: "sessions", action: "read", target: child.title, callId: "c" },
        },
        {
          seq: 2,
          parentSeq: 1,
          type: "tool_result",
          createdAt: 3,
          payload: { tool: "sessions", action: "read", callId: "c", title: child.title },
        },
      ];
      let release: (() => void) | undefined;
      const held = (body: unknown) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(Response.json(status === 200 ? body : { error: "denied" }, { status }));
        });
      const h = await harness({
        path: "/s/root",
        session: root,
        listSessions: rows,
        entries,
        onRequest: (path, init) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (path === "/api/session-navigation")
            return Response.json(projectSessionNavigation(rows, rows, [], "tester", body));
          if (path === "/api/session-navigation/page") {
            const page = projectSessionPage(rows, [], body);
            return phase === "title" && body.title ? held(page) : Response.json(page);
          }
          if (path === "/api/session-navigation/resolve")
            return Response.json(resolveSessionReferences(rows, body.references));
          if (phase === "transcript" && path.startsWith("/api/sessions/child?"))
            return held({ session: child, entries: [] });
          return undefined;
        },
      });
      try {
        await h.boot();
        await waitFor(() => Boolean(document.querySelector("button.subagent-chip")));
        document.querySelector<HTMLButtonElement>("button.subagent-chip")!.click();
        await waitFor(() => Boolean(release));
        h.switchView("settings");
        release!();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(h.appState.currentView, "settings");
        assert.doesNotMatch(h.mainText(), /Couldn't open that session/);
        assert.notEqual(h.visibleConversation().state.sessionId, child.id);
        if (phase === "title")
          assert.equal(
            h.requests.some((path) => path.startsWith("/api/sessions/child?")),
            false,
          );
      } finally {
        release?.();
        await h.close();
      }
    });
  }
}
