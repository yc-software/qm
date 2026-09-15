import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

interface ServerFile {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  direction: "out";
  createdAt: number;
  createdInScope: string;
  ownerScopeId: string;
  openable: boolean;
  deletable: boolean;
}

const scope = "personal:alice@example.com";
const listing: ServerFile[] = [
  {
    id: "mine/1",
    name: "mine.png",
    mimetype: "image/png",
    sizeBytes: 12,
    direction: "out",
    createdAt: 3_000,
    createdInScope: scope,
    ownerScopeId: scope,
    openable: true,
    deletable: true,
  },
  {
    id: "no-bytes",
    name: "no-bytes.png",
    mimetype: "image/png",
    sizeBytes: 12,
    direction: "out",
    createdAt: 2_500,
    createdInScope: scope,
    ownerScopeId: scope,
    openable: false,
    deletable: true,
  },
  {
    id: "ghost",
    name: "ghost.png",
    mimetype: "image/png",
    sizeBytes: 12,
    direction: "out",
    createdAt: 2_000,
    createdInScope: scope,
    ownerScopeId: scope,
    openable: true,
    deletable: true,
  },
  {
    id: "theirs",
    name: "theirs.png",
    mimetype: "image/png",
    sizeBytes: 12,
    direction: "out",
    createdAt: 1_000,
    createdInScope: scope,
    ownerScopeId: "personal:bob@example.com",
    openable: true,
    deletable: false,
  },
];

test("the Files page deletes only what the server marked deletable, once per confirmed click", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/?view=files",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  let confirmed = true;
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    confirm: () => confirmed,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let live = [...listing];
  const deletes: string[] = [];
  const inFlight: Array<Promise<unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const answer = async (): Promise<Response> => {
      if (url.pathname === "/api/contexts")
        return Response.json({ contexts: [{ scopeId: scope, kind: "personal", name: "Personal" }] });
      if (url.pathname === "/api/files" && (init?.method ?? "GET") === "GET")
        return Response.json({
          owned: live.filter((f) => f.ownerScopeId === scope),
          shared: live.filter((f) => f.ownerScopeId !== scope),
        });
      if (init?.method === "DELETE" && url.pathname.startsWith("/api/files/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/files/".length));
        deletes.push(id);
        if (id === "ghost") return Response.json({ error: "not_found", message: "no such file" }, { status: 404 });
        live = live.filter((f) => f.id !== id);
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
    };
    const pending = answer();
    inFlight.push(pending);
    return pending;
  }) as typeof globalThis.fetch;

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 8; round++) {
      await Promise.allSettled(inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const vite = await createServer({
    root: packageRoot,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderFiles } = await vite.ssrLoadModule("/src/files.ts");
    appState.me = { user: "alice@example.com", org: "acme" };
    appState.currentView = "files";
    appState.mainEl = document.querySelector("#main");

    const rows = () =>
      [...document.querySelectorAll<HTMLElement>(".file-row")].map((row) => ({
        name: row.querySelector(".list-row-title")?.textContent ?? "",
        opens: Boolean(row.querySelector("a.file-row-main")),
        deletable: Boolean(row.querySelector(".file-row-actions button")),
      }));
    const deleteButton = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".file-row")]
        .find((row) => row.querySelector(".list-row-title")?.textContent === name)
        ?.querySelector<HTMLButtonElement>(".file-row-actions button") ?? null;
    const status = () => document.querySelector(".status")?.textContent ?? "";
    const click = (button: HTMLButtonElement) => button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await renderFiles();
    await settle();
    assert.deepEqual(
      rows(),
      [
        { name: "mine.png", opens: true, deletable: true },
        { name: "no-bytes.png", opens: false, deletable: true },
        { name: "ghost.png", opens: true, deletable: true },
        { name: "theirs.png", opens: true, deletable: false },
      ],
      "the button follows the server's deletable flag, independently of whether the row opens",
    );
    const button = deleteButton("mine.png")!;
    assert.equal(button.textContent?.trim(), "Delete");
    assert.equal(button.getAttribute("aria-label"), "Delete mine.png");
    assert.equal(
      document.querySelector("a.file-row-main button"),
      null,
      "nesting the button inside the open anchor would navigate on every delete click",
    );

    confirmed = false;
    click(deleteButton("mine.png")!);
    await settle();
    assert.deepEqual(deletes, [], "declining the confirm sends nothing");
    assert.equal(rows().length, 4);
    assert.equal(status(), "");

    confirmed = true;
    click(deleteButton("mine.png")!);
    const busy = deleteButton("mine.png")!;
    assert.equal(busy.disabled, true, "the in-flight row's button is disabled");
    click(busy);
    await settle();
    assert.deepEqual(deletes, ["mine/1"], "a double click deletes once, and the id survives URL encoding intact");
    assert.deepEqual(
      rows(),
      [
        { name: "no-bytes.png", opens: false, deletable: true },
        { name: "ghost.png", opens: true, deletable: true },
        { name: "theirs.png", opens: true, deletable: false },
      ],
      "the reload drops the deleted row instead of resurrecting it",
    );
    assert.equal(status(), "Deleted mine.png.");

    click(deleteButton("ghost.png")!);
    await settle();
    assert.deepEqual(deletes, ["mine/1", "ghost"]);
    assert.equal(status(), "no such file", "a refusal replaces the success notice with the server's reason");
    assert.equal(rows().length, 3, "a failed delete keeps the row");
    assert.equal(deleteButton("ghost.png")!.disabled, false, "the row is retryable after a failure");
  } finally {
    await vite.close();
    globalThis.fetch = realFetch;
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
  }
});
