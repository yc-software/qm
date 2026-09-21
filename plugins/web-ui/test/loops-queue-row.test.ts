import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function loop(id: string, name: string, queue?: Record<string, number>): Record<string, unknown> {
  return {
    id,
    name,
    playbook: "triage",
    playbookVersion: 1,
    playbookHistory: [],
    policyVersion: 1,
    successCondition: "a fix PR is linked",
    shipActions: [{ action: "open_pr", gate: "hold" }],
    state: "enabled",
    health: "healthy",
    owner: "alice@example.com",
    ...(queue ? { queue } : {}),
  };
}

const loops = [
  loop("mixed", "Mixed", { queued: 2, inProgress: 1, ready: 0, failed: 0, oldestQueuedAgeMs: 90_000 }),
  loop("idle", "Idle", { queued: 0, inProgress: 0, ready: 0, failed: 0 }),
  loop("waiting", "Waiting", { queued: 3, inProgress: 0, ready: 0, failed: 0, oldestQueuedAgeMs: 10_000 }),
  loop("working", "Working", { queued: 0, inProgress: 1, ready: 0, failed: 0 }),
  loop("legacy", "Legacy"),
];

test("each loop row reads its own queue, and a core that omits the counts renders the row unchanged", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/?view=loops",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
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
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { queue: _listOnly, ...mixedRecord } = loops[0]!;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/loops") return Response.json({ loops });
    if (url.pathname === "/api/loops/mixed")
      return Response.json({
        loop: mixedRecord,
        items: [],
        outputs: [],
        grants: [],
        vitals: { queue: { queued: 2, inProgress: 1, ready: 0, failed: 0 }, openOutputs: 0 },
      });
    throw new Error(`unexpected request: ${url.pathname}`);
  }) as typeof globalThis.fetch;

  const until = async (ready: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  const vite = await createServer({
    root: packageRoot,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderLoopsPage } = await vite.ssrLoadModule("/src/loops.ts");
    appState.me = { user: "alice@example.com", org: "acme", permissions: ["loops"] };
    appState.currentView = "loops";
    appState.mainEl = document.querySelector("#main");

    await renderLoopsPage();

    const rows = [...document.querySelectorAll<HTMLElement>("button.list-row.loop-row")];
    assert.deepEqual(
      rows.map((row) => [...row.querySelectorAll(".loop-row-meta")].map((meta) => meta.textContent?.trim())),
      [
        ["last fire never", "1 working · 2 queued"],
        ["last fire never", "queue empty"],
        ["last fire never", "3 queued"],
        ["last fire never", "1 working"],
        ["last fire never"],
      ],
    );

    const queueSpan = [...rows[0]!.querySelectorAll<HTMLElement>(".loop-row-meta")].at(-1)!;
    queueSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await until(() => document.querySelector(".pane-title") !== null, "the loop detail pane");
    assert.equal(document.querySelector(".pane-title")?.textContent, "Mixed");
  } finally {
    await vite.close();
    dom.window.close();
  }
});
