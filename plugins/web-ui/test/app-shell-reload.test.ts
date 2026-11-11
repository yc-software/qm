import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { appShellHtml } from "../../../src/deploy/app-shell.ts";
import type { RunActivityEntry } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { harness } from "./deep-link-boot-fixture.ts";

const PORTAL = "https://portal.example.com";
const APP = "https://demo.apps.example.com";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("an open app reloads for each save its chat reports, even one that lands during the previous reload", async () => {
  const dom = new JSDOM(appShellHtml({ slug: "demo", portalUrl: PORTAL, path: "/" }), {
    url: APP,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  let served: { version: number; live?: number } = { version: 1 };
  let held: Promise<void> | undefined;
  win.fetch = (async () => {
    const answer = served;
    await held;
    return { ok: true, json: async () => answer };
  }) as unknown as typeof win.fetch;
  let reloads = 0;
  const app = win.document.querySelector<HTMLIFrameElement>("#app")!;
  Object.defineProperty(app, "contentWindow", {
    get: () => ({ location: { href: "about:blank", reload: () => reloads++ } }),
  });
  win.eval(win.document.querySelector("script")!.textContent!);
  const chat = win.document.querySelector<HTMLIFrameElement>("#chat")!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const chatReports = async (origin = PORTAL) => {
    win.dispatchEvent(
      new win.MessageEvent("message", { origin, source: chat.contentWindow, data: { type: "qm:app-check" } }),
    );
    await settle();
  };
  await settle();
  win.document.querySelector<HTMLButtonElement>("#chat-toggle")!.click();

  served = { version: 1, live: 1 };
  await chatReports("https://attacker.example.com");
  assert.equal(reloads, 0);
  await chatReports();
  assert.equal(reloads, 1);

  served = { version: 1, live: 2 };
  app.dispatchEvent(new win.Event("load"));
  await chatReports();
  assert.equal(reloads, 2);
  await chatReports();
  assert.equal(reloads, 2);

  let release = (): void => {};
  held = new Promise((resolve) => (release = resolve));
  await chatReports();
  held = undefined;
  served = { version: 1, live: 3 };
  await chatReports();
  assert.equal(reloads, 3);
  release();
  await settle();
  assert.equal(reloads, 3, "an older answer arriving late does not reload back");
  dom.window.close();
});

test("a chat embedded beside an app tells the app bar to check for a change once per finished tool", async () => {
  const session = {
    id: "sess-app",
    threadRef: "web:tester:app-edit:demo",
    scopeId: "personal:tester",
    title: "demo",
    canContinue: true,
  };
  const startedAt = Date.now() - 3000;
  const step = (kind: "ToolCall" | "ToolResult", seq: number, callId: string, path: string) => ({
    item: item(kind, { seq, createdAt: startedAt + seq, tool: "app_files", callId, body: { action: "edit", path } }),
  });
  const activity: RunActivityEntry[] = [step("ToolCall", 2, "c1", "styles.css")];
  const run = () => ({ status: "running", alive: true, startedAt, attempt: 1, activity, result: null });
  const h = await harness({
    path: "/app-edit?slug=demo&embed=1",
    session,
    listSessions: [session],
    items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "make the title teal" })],
    api: (path) => {
      if (path.includes("/api/runs/active")) return Response.json({ runId: "r1", run: run(), queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json(run());
      return undefined;
    },
  });
  const embedder = new JSDOM("", { url: APP }).window;
  try {
    const told: Array<{ type: string; origin: string }> = [];
    embedder.postMessage = ((data: { type: string }, origin: string) =>
      told.push({ type: data.type, origin })) as unknown as typeof embedder.postMessage;
    Object.defineProperty(window, "parent", { configurable: true, value: embedder });
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: embedder as unknown as Window,
        origin: APP,
        data: { type: "qm:theme-request" },
      }),
    );
    const checks = () => told.filter((message) => message.type === "qm:app-check");
    const working = () => document.querySelector(".custom-chat")?.textContent ?? "";

    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => /styles\.css/.test(working()));
    assert.deepEqual(checks(), []);

    activity.push(step("ToolResult", 3, "c1", "styles.css"));
    await until(() => checks().length === 1);
    assert.deepEqual(checks(), [{ type: "qm:app-check", origin: APP }]);

    activity.push(step("ToolCall", 4, "c2", "about.html"));
    await until(() => /about\.html/.test(working()));
    assert.equal(checks().length, 1);

    activity.push(step("ToolResult", 5, "c2", "about.html"));
    await until(() => checks().length === 2);
  } finally {
    embedder.close();
    await h.close();
  }
});
