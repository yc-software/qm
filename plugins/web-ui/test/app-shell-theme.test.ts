import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { isPalette, themeCss, themeTokens } from "../src/theme-import.ts";
import { JSDOM, type DOMWindow } from "jsdom";
import { appShellHtml } from "../../../src/deploy/app-shell.ts";

const settings = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
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

test("embedded chat publishes active colors and tracks theme changes from other tabs", () => {
  const dom = new JSDOM("<iframe></iframe>", { url: "https://portal.example.com", runScripts: "outside-only" });
  const frame = dom.window.document.querySelector("iframe")!.contentWindow as unknown as DOMWindow;
  const messages: Array<{ data: { dark: boolean; colors: Record<string, string> }; origin: string }> = [];
  dom.window.postMessage = (data, origin) => messages.push({ data, origin: origin as string });
  Object.assign(frame, { isPalette, themeCss, themeTokens });
  frame.eval("window.matchMedia = () => ({ matches: false, addEventListener() {} });");
  const source =
    settings.slice(settings.indexOf("export function storedTheme"), settings.indexOf("let themeParentOrigin")) +
    settings.slice(settings.indexOf("let themeParentOrigin"), settings.indexOf("export function setTheme")) +
    settings.slice(settings.indexOf("export function watchSystemTheme"), settings.indexOf("function themeSwatches"));
  frame.eval(
    stripTypeScriptTypes(
      'const THEME_KEY = "theme", CUSTOM_THEME_KEY = "theme:custom", CUSTOM_THEME_STYLE_ID = "custom-theme";\n' +
        source.replaceAll("export function", "function"),
    ),
  );
  const style = frame.document.createElement("style");
  style.textContent = `:root { ${keys.map((key) => `${key}: #abcdef;`).join(" ")} }`;
  frame.document.head.appendChild(style);
  frame.eval("applyTheme(); watchSystemTheme();");
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
  const palette = {
    name: "Forest",
    source: "iterm2",
    background: { r: 16, g: 40, b: 32 },
    foreground: { r: 220, g: 252, b: 231 },
    ansi: Array(16).fill(null),
  };
  frame.localStorage.setItem("theme:custom", JSON.stringify(palette));
  frame.localStorage.setItem("theme", "custom");
  frame.dispatchEvent(new frame.StorageEvent("storage", { key: "theme" }));
  assert.equal(messages.at(-1)!.data.dark, true);
  assert.equal(messages.at(-1)!.data.colors["--background"], "#102820");
  frame.localStorage.clear();
  frame.dispatchEvent(new frame.StorageEvent("storage", { key: null }));
  assert.equal(messages.at(-1)!.data.dark, false);
  dom.window.close();
});

test("theme-only startup stops before authenticated chat boot", async () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const boot = stripTypeScriptTypes(shell.slice(shell.indexOf("export async function boot():")).replace("export ", ""));
  const location = { search: "?slug=demo&embed=1&themeOnly=1" };
  let started = false;
  const run = runInNewContext(boot + "; boot", {
    location,
    URLSearchParams,
    captureConnectionReturn: () => {
      started = true;
      throw new Error("chat boot");
    },
  }) as () => Promise<void>;
  await run();
  assert.equal(started, false);
  location.search = "?slug=demo&embed=1";
  await assert.rejects(run(), /chat boot/);
  assert.equal(started, true);
});
