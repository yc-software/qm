import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { api } from "../src/core-bridge.ts";

test("board preserves selection ordering and timeline cursors across refresh and reconnect", async () => {
  const dom = new JSDOM('<!doctype html><main id="board-demo"></main>', {
    url: "http://localhost/test/support/board-demo.html",
  });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "FormData",
    "customElements",
  ]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "window" ? dom.window : Reflect.get(dom.window, key),
    });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/test/support/board-demo.ts");
    const body = dom.window.document.body;
    assert.equal(dom.window.location.pathname, "/board/request");
    assert.doesNotMatch(body.textContent!, /fixture message not found/);
    assert.match(body.textContent!, /Notification: delivered/);
    assert.match(body.textContent!, /Run: done/);
    assert.doesNotMatch(body.textContent!, /Reply waits|consumed|autonomous budget/);

    const { request } = (await vite.ssrLoadModule("/test/support/board-demo.ts")) as { request: typeof api };
    const { renderBoardPage } = await vite.ssrLoadModule("/src/board.ts");
    const delayed = Promise.withResolvers<void>();
    let requested = false;
    const intercepted: typeof api = async <T>(path: string, options?: RequestInit): Promise<T> => {
      if (path === "/api/peer-messages/request") {
        requested = true;
        await delayed.promise;
      }
      return request<T>(path, options);
    };
    dom.window.history.replaceState(null, "", "/board/reply");
    await renderBoardPage(intercepted);
    const select = (id: string) => {
      const anchor = [...body.querySelectorAll<HTMLAnchorElement>("a")].find(
        (node) => node.pathname === `/board/${id}`,
      );
      assert.ok(anchor);
      anchor.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    };
    select("request");
    assert.equal(requested, true);
    select("observation");
    for (
      let i = 0;
      i < 20 && !body.querySelector("#board-inspector-heading")?.parentElement?.textContent?.includes("Reviewer");
      i++
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.match(body.querySelector("#board-inspector-heading")!.parentElement!.textContent!, /Reviewer/);
    const searchInput = body.querySelector<HTMLInputElement>('input[type="search"]');
    assert.ok(searchInput);
    searchInput.focus();
    delayed.resolve();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dom.window.location.pathname, "/board/observation");
    assert.match(body.querySelector("#board-inspector-heading")!.parentElement!.textContent!, /Reviewer/);
    assert.equal(dom.window.document.activeElement, searchInput);

    const sameIdDelayed = Promise.withResolvers<void>();
    let sameIdRequested = false;
    const sameIdIntercepted: typeof api = async <T>(path: string, options?: RequestInit): Promise<T> => {
      if (path === "/api/peer-messages/request" && !sameIdRequested) {
        sameIdRequested = true;
        await sameIdDelayed.promise;
      }
      return request<T>(path, options);
    };
    dom.window.history.replaceState(null, "", "/board/reply");
    await renderBoardPage(sameIdIntercepted);
    select("request");
    assert.equal(sameIdRequested, true);
    select("observation");
    select("request");
    for (
      let i = 0;
      i < 20 && !body.querySelector("#board-inspector-heading")?.parentElement?.textContent?.includes("Planner");
      i++
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.match(body.querySelector("#board-inspector-heading")!.parentElement!.textContent!, /Planner/);
    assert.equal(dom.window.document.activeElement?.id, "board-inspector-heading");
    const sameIdSearch = body.querySelector<HTMLInputElement>('input[type="search"]');
    assert.ok(sameIdSearch);
    sameIdSearch.focus();
    sameIdDelayed.resolve();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dom.window.location.pathname, "/board/request");
    assert.equal(dom.window.document.activeElement, sameIdSearch);
    assert.match(body.querySelector("#board-inspector-heading")!.parentElement!.textContent!, /Planner/);

    const timeline = await request<{ messages: Array<{ id: string; sequence: number }> }>("/api/peer-messages");
    const cursors: string[] = [];
    const reconnecting: typeof api = async <T>(path: string, options?: RequestInit): Promise<T> => {
      const url = new URL(path, dom.window.location.origin);
      if (url.pathname !== "/api/peer-messages") return request<T>(path, options);
      cursors.push(url.searchParams.get("after")!);
      if (cursors.length === 2) throw new Error("temporary disconnect");
      const rows = timeline.messages.slice(0, cursors.length === 1 ? 1 : 2);
      return { messages: rows, nextCursor: rows.at(-1)!.sequence, hasMore: false } as T;
    };
    dom.window.history.replaceState(null, "", "/board");
    await renderBoardPage(reconnecting);
    const refresh = () => {
      const button = [...body.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.trim() === "Check for new messages",
      );
      assert.ok(button);
      button.click();
    };
    assert.equal(body.querySelectorAll(".board-message").length, 1);
    refresh();
    for (let i = 0; i < 20 && !body.textContent?.includes("temporary disconnect"); i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.match(body.textContent!, /Connection interrupted: temporary disconnect/);
    assert.match(body.textContent!, /Resumes from durable cursor 1/);
    assert.equal(body.querySelectorAll(".board-message").length, 1);
    for (let i = 0; i < 100 && body.querySelectorAll(".board-message").length !== 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(cursors, ["0", "1", "1"]);
    assert.equal(body.querySelectorAll(".board-message").length, 2);
    assert.doesNotMatch(body.textContent!, /Connection interrupted/);
    assert.match(body.textContent!, /Resumes from durable cursor 2/);
    const deletedTree: typeof api = async <T>(path: string, options?: RequestInit): Promise<T> => {
      if (path === "/api/peers/root/subtree")
        return {
          manageable: true,
          nodes: [
            { peer: { id: "root", parentId: null, name: "Root", state: "active", character: {} }, count: 1, cap: 1 },
            {
              peer: { id: "deleted", parentId: "root", name: "Deleted worker", state: "deleted", character: {} },
              count: 0,
              cap: 16,
              spawn: { state: "failed", attempts: 1, updatedAt: Date.now(), reason: "spawn_session_unavailable" },
            },
          ],
        } as T;
      return request<T>(path, options);
    };
    await renderBoardPage(deletedTree);
    const agentInput = body.querySelector<HTMLInputElement>('input[name="agent"]')!;
    agentInput.value = "root";
    agentInput.form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 20 && !body.textContent?.includes("unfinished spawn reservation"); i++)
      await new Promise((resolve) => setImmediate(resolve));
    const deletedNode = [...body.querySelectorAll<HTMLElement>(".board-tree-node")].find(
      (node) => node.querySelector("strong")?.textContent === "Deleted worker",
    );
    assert.ok(deletedNode);
    assert.match(deletedNode.textContent!, /unfinished spawn reservation still occupies an ancestor slot/);
    assert.equal(deletedNode.querySelectorAll("button:disabled").length, 3);
    assert.equal(deletedNode.querySelector("a"), null);
  } finally {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.currentView = "chats";
    dom.window.document.body.replaceChildren();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
