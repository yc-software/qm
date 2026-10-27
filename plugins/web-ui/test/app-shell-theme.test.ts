import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, type DOMWindow } from "jsdom";
import { createServer } from "vite";
import { appShellHtml } from "../../../src/deploy/app-shell.ts";
import { harness } from "./deep-link-boot-fixture.ts";

const keys = ["--background", "--foreground", "--secondary", "--muted-foreground", "--border", "--brand-accent"];

test("the app bar accepts the chat palette only from its portal iframe, even while closed", () => {
  const dom = new JSDOM(appShellHtml({ slug: "demo", portalUrl: "https://portal.example.com", path: "/app" }), {
    url: "https://demo.apps.example.com",
    runScripts: "outside-only",
  });
  const win = dom.window;
  win.eval(
    "window.CSS = { supports: (_, value) => /^#[0-9a-f]{6}$/.test(value) }; window.fetch = async () => ({ ok: false });",
  );
  win.eval(win.document.querySelector("script")!.textContent!);
  const chat = win.document.querySelector<HTMLIFrameElement>("#chat")!;
  const root = win.document.documentElement;
  const colors = Object.fromEntries(keys.map((key) => [key, "#123456"]));
  const send = (origin: string, source: unknown, palette = colors, dark = true) =>
    win.dispatchEvent(
      new win.MessageEvent("message", {
        origin,
        source: source as Window,
        data: { type: "qm:theme", dark, colors: palette },
      }),
    );
  assert.match(chat.src, /app-edit\?slug=demo&embed=1&themeOnly=1$/);
  assert.equal(win.document.querySelector("#panel")!.classList.contains("open"), false);
  send("https://attacker.example.com", chat.contentWindow);
  send("https://portal.example.com", win.document.querySelector<HTMLIFrameElement>("#app")!.contentWindow);
  assert.equal(root.style.getPropertyValue("--background"), "");
  send("https://portal.example.com", chat.contentWindow);
  for (const key of keys) assert.equal(root.style.getPropertyValue(key), "#123456");
  assert.equal(root.style.colorScheme, "dark");
  send("https://portal.example.com", chat.contentWindow, { ...colors, "--border": "bad" });
  assert.equal(root.style.getPropertyValue("--border"), "#123456");
  send("https://portal.example.com", chat.contentWindow, colors, false);
  assert.equal(root.style.colorScheme, "light");
  win.document.querySelector<HTMLButtonElement>("#chat-toggle")!.click();
  assert.match(chat.src, /app-edit\?slug=demo&embed=1$/);
  win.document.querySelector<HTMLButtonElement>("#chat-toggle")!.click();
  assert.match(chat.src, /app-edit\?slug=demo&embed=1$/);
  dom.window.close();
});

test("embedded chat publishes active colors and tracks theme changes from other tabs", async (t) => {
  const dom = new JSDOM("<iframe></iframe>", { url: "https://portal.example.com", runScripts: "outside-only" });
  const frame = dom.window.document.querySelector("iframe")!.contentWindow as unknown as DOMWindow;
  const messages: Array<{ data: { dark: boolean; colors: Record<string, string> }; origin: string }> = [];
  dom.window.postMessage = (data, origin) => messages.push({ data, origin: origin as string });
  frame.document.body.innerHTML = '<div id="app"></div>';
  frame.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: frame,
    document: frame.document,
    location: frame.location,
    history: frame.history,
    localStorage: frame.localStorage,
    sessionStorage: frame.sessionStorage,
    navigator: frame.navigator,
    HTMLElement: frame.HTMLElement,
    Element: frame.Element,
    Node: frame.Node,
    customElements: frame.customElements,
    getComputedStyle: frame.getComputedStyle.bind(frame),
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  t.after(async () => {
    await vite.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  });
  await vite.ssrLoadModule("/src/shell.ts");
  const style = frame.document.createElement("style");
  style.textContent = `:root { ${keys.map((key) => `${key}: #abcdef;`).join(" ")} }`;
  frame.document.head.appendChild(style);
  frame.dispatchEvent(
    new frame.MessageEvent("message", {
      source: dom.window as unknown as Window,
      origin: "https://demo.apps.example.com",
      data: { type: "qm:theme-request" },
    }),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, "https://demo.apps.example.com");
  assert.equal(messages[0].data.colors["--background"], "#abcdef");
  assert.equal(messages[0].data.dark, false);
  frame.localStorage.setItem("theme", "dark");
  frame.dispatchEvent(new frame.StorageEvent("storage", { key: "theme" }));
  assert.equal(messages.at(-1)!.data.dark, true);
  frame.localStorage.clear();
  frame.dispatchEvent(new frame.StorageEvent("storage", { key: null }));
  assert.equal(messages.at(-1)!.data.dark, false);
});

test("theme-only startup stops before authenticated chat boot", async () => {
  const themeOnly = await harness({ path: "/?slug=demo&embed=1&themeOnly=1" });
  try {
    await themeOnly.boot();
    assert.deepEqual(themeOnly.requests, []);
  } finally {
    await themeOnly.close();
  }
  const chat = await harness({ path: "/?slug=demo&embed=1" });
  try {
    chat.releaseSessions();
    await chat.boot();
    assert.ok(chat.requests.includes("/me"));
  } finally {
    await chat.close();
  }
});
