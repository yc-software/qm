import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { LOCALE_STORAGE_KEY, readLocale, setLocale, translateUiText } from "../src/locale.ts";

test("locale storage is shared and explicit choices win", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  values.set(LOCALE_STORAGE_KEY, "zh-CN");
  assert.equal(readLocale(storage), "zh-CN");
  setLocale("en", storage);
  assert.equal(values.get(LOCALE_STORAGE_KEY), "en");
});

test("Chinese translations preserve whitespace and dynamic counts", () => {
  assert.equal(translateUiText("  New chat\n", "zh-CN"), "  新建聊天\n");
  assert.equal(translateUiText("3 conversations selected", "zh-CN"), "已选择 3 个会话");
  assert.equal(translateUiText("Hide Browse", "zh-CN"), "隐藏浏览");
  assert.equal(
    translateUiText(
      "\n  This surface is reached through the portal, and signing in there didn't produce a session for it.\n  Open the portal address directly rather than this one.\n",
      "zh-CN",
    ),
    "\n  此界面需要通过门户登录，但门户没有为它建立会话。请直接打开门户地址。\n",
  );
  assert.equal(translateUiText("New chat", "en"), "New chat");
});

test("localization does not translate user content or code", async () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <button title="New chat">New chat</button>
      <markdown-block>New chat</markdown-block>
      <pre>Files</pre>
      <span class="list-row-title">Files</span>
      <a class="session"><span class="tl">New chat</span></a>
      <span class="chat-search-snippet">Memory</span>
      <span class="cron-preview">Files</span>
      <div class="value pre">Files</div>
      <select><option value="files">Files</option></select>
      <span data-no-localize>New chat</span>
    </body></html>`,
    { url: "http://localhost" },
  );
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    MutationObserver: globalThis.MutationObserver,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    Element: globalThis.Element,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
  });
  try {
    const locale = await import(`../src/locale.ts?dom=${Date.now()}`);
    locale.setLocale("zh-CN");
    locale.startLocalization();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = dom.window.document.querySelector("button")!;
    assert.equal(button.textContent, "新建聊天");
    assert.equal(button.title, "新建聊天");
    assert.equal(dom.window.document.querySelector("markdown-block")!.textContent, "New chat");
    assert.equal(dom.window.document.querySelector("pre")!.textContent, "Files");
    assert.equal(dom.window.document.querySelector(".list-row-title")!.textContent, "Files");
    assert.equal(dom.window.document.querySelector(".session .tl")!.textContent, "New chat");
    assert.equal(dom.window.document.querySelector(".chat-search-snippet")!.textContent, "Memory");
    assert.equal(dom.window.document.querySelector(".cron-preview")!.textContent, "Files");
    assert.equal(dom.window.document.querySelector(".value.pre")!.textContent, "Files");
    assert.equal(dom.window.document.querySelector("option")!.textContent, "Files");
    assert.equal(dom.window.document.querySelector("[data-no-localize]")!.textContent, "New chat");
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("locale controls are available before sign-in and meet the mobile touch target", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  assert.match(shell, /function gateShell[\s\S]*\$\{localeControl\(\)\}/);
  assert.match(shell, /function mountShell[\s\S]*\$\{localeControl\(\)\}/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.locale-select > select \{\s*min-height: 44px/);
});
