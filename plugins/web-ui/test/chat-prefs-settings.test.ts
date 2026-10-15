import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("chat preference rows persist to per-user ui-state", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/settings" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const saved: Array<{ key: string; value: unknown }> = [];
  const stored = new Map<string, unknown>();
  let holdReads: Promise<void> = Promise.resolve();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    customElements: dom.window.customElements,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/ui-state")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { key: string; value: unknown };
          saved.push({ key: body.key, value: body.value });
          stored.set(body.key, body.value);
          return Response.json({ ok: true, updatedAt: 1 });
        }
        await holdReads;
        const key = url.searchParams.get("key")!;
        return Response.json({ value: stored.get(key) ?? null, updatedAt: stored.has(key) ? 1 : 0 });
      }
      return Response.json({});
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    plugins: [
      {
        name: "settings-shell-boundary",
        enforce: "pre",
        resolveId(source, importer) {
          if (!importer?.endsWith("/src/settings.ts")) return;
          if (source === "./shell" || source === "./sessions") return `\0settings-test:${source}`;
        },
        load(id) {
          if (id === "\0settings-test:./shell")
            return 'export { appState, can } from "/src/shell-state.ts"; export const ADMIN_HOME_URL = "/admin"; export function signOut() {}';
          if (id === "\0settings-test:./sessions")
            return "export const sessionsState = { webOnly: false }; export function setWebOnly(value) { sessionsState.webOnly = value; }";
        },
      },
    ],
  });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderSettings } = await vite.ssrLoadModule("/src/settings.ts");
    const prefs = await vite.ssrLoadModule("/src/core-bridge.ts");
    appState.me = { user: "alice", org: "acme" };
    appState.currentView = "settings";
    appState.mainEl = document.querySelector("#app");
    const choice = (group: string, label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)].find(
        (el) => el.textContent?.trim() === label,
      )!;
    const checked = (group: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)]
        .filter((el) => el.getAttribute("aria-checked") === "true")
        .map((el) => el.textContent?.trim());
    let changes = 0;
    const stop = prefs.onChatPrefsChange(() => changes++);

    await t.test("defaults keep today's behavior", () => {
      renderSettings();
      assert.deepEqual(checked("Pin my last message"), ["Pinned"]);
      assert.deepEqual(checked("Sending while QM is working"), ["Queue"]);
      assert.equal(prefs.pinLatestPrompt(), true);
      assert.equal(prefs.alwaysSteer(), false);
    });

    await t.test("the server value loads at boot unless the user already chose this session", async () => {
      stored.set("pin-latest-prompt", false);
      stored.set("always-steer", false);
      let release!: () => void;
      holdReads = new Promise((resolve) => (release = resolve));
      const loading = prefs.loadChatPrefs();
      choice("Sending while QM is working", "Steer").click();
      release();
      await loading;
      assert.equal(prefs.pinLatestPrompt(), false);
      assert.equal(localStorage.getItem("chat-pref:pin-latest-prompt"), "0");
      assert.equal(prefs.alwaysSteer(), true);
      renderSettings();
      assert.deepEqual(checked("Pin my last message"), ["Off"]);
      assert.deepEqual(checked("Sending while QM is working"), ["Steer"]);
      assert.equal(changes, 2);
    });

    await t.test("choosing an option saves it for the user and notifies open chats", async () => {
      saved.length = 0;
      changes = 0;
      choice("Pin my last message", "Pinned").click();
      choice("Sending while QM is working", "Queue").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(saved, [
        { key: "pin-latest-prompt", value: true },
        { key: "always-steer", value: false },
      ]);
      assert.deepEqual(checked("Pin my last message"), ["Pinned"]);
      assert.deepEqual(checked("Sending while QM is working"), ["Queue"]);
      assert.equal(prefs.pinLatestPrompt(), true);
      assert.equal(prefs.alwaysSteer(), false);
      assert.equal(changes, 2);
      assert.equal(localStorage.getItem("chat-pref:pin-latest-prompt"), null);
      assert.equal(localStorage.getItem("chat-pref:always-steer"), null);
      choice("Pin my last message", "Off").click();
      assert.deepEqual(saved.at(-1), { key: "pin-latest-prompt", value: false });
      assert.equal(localStorage.getItem("chat-pref:pin-latest-prompt"), "0");
    });

    stop();
    appState.currentView = "chats";
    appState.mainEl = null;
  } finally {
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
