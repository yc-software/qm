import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

async function settle(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("board did not settle");
}

test("board navigation discards old previews, old errors, and drafts belonging to another message", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/board",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  const preview = Promise.withResolvers<Response>();
  const sending = Promise.withResolvers<Response>();
  let previewStarted = false;
  let sendStarted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const session = url.pathname.split("/")[3]!;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "preview") {
        previewStarted = true;
        return preview.promise;
      }
      if (body.action === "send") {
        sendStarted = true;
        return sending.promise;
      }
    }
    if (url.searchParams.has("discover"))
      return Response.json({ peers: [{ id: "peer", name: "Peer", version: 1, character: {} }] });
    if (url.searchParams.has("board"))
      return Response.json({
        visibility: url.searchParams.get("visibility"),
        selfId: session,
        writable: true,
        canManage: false,
        members: [
          {
            id: session,
            name: session,
            state: "ready",
            effectiveState: "active",
            control: "active",
            descendants: 0,
            descendantLimit: 2,
            attempts: 0,
            depth: 0,
          },
        ],
        messages: [
          {
            id: url.searchParams.get("id") ?? "first",
            text: "Message",
            visibility: url.searchParams.get("visibility"),
            sender: { id: session, name: session },
            audience: [],
            createdAt: 1,
            author: "human",
            notifications: {},
          },
        ],
        replies: [],
        deliveries: [],
      });
    return Response.json({});
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const board = await vite.ssrLoadModule("/src/board.ts");
    appState.me = { user: "alice", org: "test" };
    appState.currentView = "board";
    appState.mainEl = document.getElementById("main");
    sessionsState.list = ["a", "b"].map((id) => ({
      id,
      title: id,
      type: "dm",
      createdAt: 0,
      threadRef: `web:alice:${id}`,
    }));
    await board.renderBoardPage();
    const click = (label: string) =>
      Array.from(document.querySelectorAll("button"))
        .find((e) => e.textContent?.trim() === label)!
        .click();
    const select = (name: string, value: string) => {
      const e = document.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
      e.value = value;
      e.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    };
    click("Preview audience");
    await settle(() => previewStarted);
    select("Acting session", "b");
    await settle(() => document.querySelector(".board-member summary")?.textContent?.startsWith("b") === true);
    preview.resolve(
      Response.json({ audience: [{ id: "old-peer", name: "Previous context", version: 1, character: {} }] }),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!document.body.textContent!.includes("Current audience preview"));

    select("Visibility", "private");
    await settle(() => document.body.textContent!.includes("Send privately"));
    click("Send privately and notify 0");
    await settle(() => sendStarted);
    board.resetBoardState();
    appState.me = { user: "bob", org: "test" };
    await board.renderBoardPage();
    sending.resolve(Response.json({ error: "Old account error" }, { status: 409 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(document.querySelector(".board-notice"), null);

    history.replaceState(null, "", "/board/first?visibility=private&session=a");
    board.routeBoardHistory("first");
    await settle(() => !!document.querySelector(".board-detail"));
    const text = document.querySelector<HTMLTextAreaElement>(".board-compose textarea")!;
    text.value = "Reply intended only for first";
    text.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const recipient = document.querySelector<HTMLInputElement>(".board-compose input[type=checkbox]")!;
    recipient.click();
    history.replaceState(null, "", "/board/second?visibility=private&session=a");
    board.routeBoardHistory("second");
    await settle(() => !!document.querySelector(".board-detail") && !document.querySelector('[role="status"]'));
    assert.equal(document.querySelector<HTMLTextAreaElement>(".board-compose textarea")!.value, "");
    assert.equal(document.querySelector<HTMLInputElement>(".board-compose input[type=checkbox]")!.checked, false);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
