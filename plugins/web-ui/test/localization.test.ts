import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer as createViteServer } from "vite";
import { catalogProblems } from "../../chassis/src/locale.ts";
import { locale, t } from "../src/i18n.ts";
import { WEB_MESSAGES, webMessage } from "../src/messages.ts";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-localization-test";
process.env.WEB_UI_PRINCIPALS = "alice";
delete process.env.QM_DEFAULT_LOCALE;

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

test.after(() => {
  surface.close();
  core.close();
});

test("web catalogs have identical keys and variables", () => {
  assert.deepEqual(catalogProblems(WEB_MESSAGES.en, WEB_MESSAGES.ja), []);
});

test("browser translation reads the normalized page locale", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM('<meta name="qm-locale" content="ja-JP">').window.document,
  });
  try {
    assert.equal(locale(), "ja");
    assert.equal(t("signOut"), "サインアウト");
    assert.equal(webMessage("en", "loading"), "Loading…");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: Document }).document;
  }
});

test("server emits English metadata by default", async () => {
  const response = await fetch(`${base}/`, { headers: { cookie: "webuiuser=alice" } });
  const body = await response.text();
  assert.match(body, /<html lang="en">/);
  assert.match(body, /<meta name="qm-locale" content="en"/);
  assert.equal(response.headers.get("vary"), "x-qm-locale, accept-language");
});

test("server emits Japanese metadata from the trusted locale", async () => {
  const response = await fetch(`${base}/`, {
    headers: { cookie: "webuiuser=alice", "x-qm-locale": "ja" },
  });
  const body = await response.text();
  assert.match(body, /<html lang="ja">/);
  assert.match(body, /<meta name="qm-locale" content="ja"/);
});

test("server ignores an invalid trusted locale and falls back to Accept-Language", async () => {
  const response = await fetch(`${base}/`, {
    headers: { cookie: "webuiuser=alice", "x-qm-locale": "fr", "accept-language": "ja-JP" },
  });
  assert.match(await response.text(), /<html lang="ja">/);
});

test("static assets do not vary by locale", async () => {
  const response = await fetch(`${base}/favicon.svg`, { headers: { "x-qm-locale": "ja" } });
  assert.equal(response.headers.get("vary"), null);
});

test("language form submits the URL at submit time after history navigation", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/chats?session=first#start" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    SubmitEvent: dom.window.SubmitEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const vite = await createViteServer({
    root: WEB_ROOT,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { mountShell } = await vite.ssrLoadModule("/src/shell.ts");
    appState.me = { user: "alice", org: "acme" };
    mountShell();
    const form = document.querySelector<HTMLFormElement>(".language-form")!;
    const select = form.elements.namedItem("locale") as HTMLSelectElement;
    const returnTo = form.elements.namedItem("returnTo") as HTMLInputElement;
    assert.equal(new URL(form.action).pathname, "/locale");
    assert.equal(form.method, "post");
    let submitted = "";
    form.addEventListener("submit", () => {
      submitted = returnTo.value;
    });
    Object.defineProperty(form, "requestSubmit", {
      value: () => form.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true })),
    });
    history.replaceState(null, "", "/files?scope=mine#recent");
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(submitted, "/files?scope=mine#recent");
  } finally {
    await vite.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("configured Japanese default localizes Vite and app-edit HTML responses", async () => {
  const names = ["QM_DEFAULT_LOCALE", "WEB_UI_DEV", "DEPLOY_APPS_DOMAIN"] as const;
  const before = new Map(names.map((name) => [name, process.env[name]]));
  let devSurface: ReturnType<typeof createServer> | undefined;
  let vite: { close(): Promise<void> } | undefined;
  try {
    process.env.QM_DEFAULT_LOCALE = "ja";
    process.env.WEB_UI_DEV = "1";
    process.env.DEPLOY_APPS_DOMAIN = "apps.test";
    const loaded = (await import(new URL("../server/index.ts?localization-vite", import.meta.url).href)) as unknown as {
      handler: typeof handler;
      startVite: (server: ReturnType<typeof createServer>) => Promise<{ close(): Promise<void> }>;
    };
    devSurface = createServer((req, res) => void loaded.handler(req, res));
    vite = await loaded.startVite(devSurface);
    await new Promise<void>((resolve) => devSurface!.listen(0, resolve));
    const devBase = `http://localhost:${(devSurface.address() as AddressInfo).port}`;
    for (const path of ["/", "/app-edit?slug=demo"]) {
      const response = await fetch(`${devBase}${path}`);
      const body = await response.text();
      assert.match(body, /<html lang="ja">/);
      assert.match(body, /<meta name="qm-locale" content="ja"/);
      assert.equal(response.headers.get("vary"), "x-qm-locale, accept-language");
    }
  } finally {
    const cleanup = await Promise.allSettled([
      ...(vite ? [vite.close()] : []),
      ...(devSurface
        ? [new Promise<void>((resolve, reject) => devSurface!.close((error) => (error ? reject(error) : resolve())))]
        : []),
    ]);
    for (const name of names) {
      const value = before.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    assert.ok(cleanup.every((result) => result.status === "fulfilled"));
  }
});

test("mobile language selection leaves room for footer controls", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.language-form \{ flex-basis: 72px; \}/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.sidebar-footer \.user-name \{ display: none; \}/);
});
