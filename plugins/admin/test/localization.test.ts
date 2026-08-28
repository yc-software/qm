import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("Admin exposes the shared English and Chinese locale control", () => {
  assert.match(html, /const LOCALE_STORAGE_KEY = "qm:locale"/);
  assert.match(html, /id="locale-select"/);
  assert.match(html, /<option value="en">EN<\/option>/);
  assert.match(html, /<option value="zh-CN">中文<\/option>/);
  assert.match(html, /startAdminLocalization\(\)/);
});

test("Admin translates primary navigation and custom-provider setup", () => {
  const start = html.indexOf('const LOCALE_STORAGE_KEY = "qm:locale"');
  const end = html.indexOf("const $ =", start);
  assert.ok(start > 0 && end > start);
  const context: Record<string, unknown> = {
    localStorage: { getItem: () => "zh-CN" },
    navigator: { language: "en-US" },
  };
  runInNewContext(
    `${html.slice(start, end)}; globalThis.translations = [translateUiText("  Custom providers\\n"), translateUiText("Fetch models"), translateUiText("Signed in as admin"), translateUiText("Get this deployment ready for real conversations.\\n Secrets are validated, encrypted in durable storage, and never displayed again.")];`,
    context,
  );
  assert.deepEqual(Array.from(context.translations as string[]), [
    "  自定义服务商\n",
    "获取模型",
    "已登录：admin",
    "完成部署配置以开始真实对话。密钥会经过验证并加密保存，之后不会再次显示。",
  ]);
});

test("Admin localization excludes transcripts and raw content", () => {
  const start = html.indexOf('const LOCALE_STORAGE_KEY = "qm:locale"');
  const end = html.indexOf("const $ =", start);
  class FakeElement {
    private readonly raw: boolean;
    constructor(raw: boolean) {
      this.raw = raw;
    }
    closest(selector: string) {
      return this.raw && selector.includes("[data-no-localize]") ? this : null;
    }
  }
  const rawText = { nodeType: 3, nodeValue: "Files", parentElement: new FakeElement(true) };
  const uiText = { nodeType: 3, nodeValue: "Files", parentElement: new FakeElement(false) };
  const context: Record<string, unknown> = {
    localStorage: { getItem: () => "zh-CN" },
    navigator: { language: "en-US" },
    Node: { TEXT_NODE: 3 },
    Element: FakeElement,
    rawText,
    uiText,
  };
  runInNewContext(
    `${html.slice(start, end)}; localizeUiNode(rawText); localizeUiNode(uiText); globalThis.values = [rawText.nodeValue, uiText.nodeValue];`,
    context,
  );
  assert.deepEqual(Array.from(context.values as string[]), ["Files", "文件"]);
  assert.match(html, /new MutationObserver/);
  assert.match(
    html,
    /adminLocalizationObserver\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/,
  );
  assert.doesNotMatch(html, /LOCALIZATION_SKIP_SELECTOR[\s\S]{0,120}textarea, option/);
  assert.match(html, /if \(parent\?\.closest\(LOCALIZATION_SKIP_SELECTOR\)\) return;/);
  assert.match(html, /Judged: "已判断"/);
  assert.match(html, /"No judgments recorded for this filter yet\.": "当前筛选条件下还没有判断记录。"/);
  assert.match(html, /else th\.textContent = translateUiText\(h\)/);
  assert.match(html, /h\.textContent = translateUiText\(s\.label\)/);
  assert.match(html, /document\.createTextNode\(translateUiText\(VIEW_TITLE\[v\]/);
  assert.match(html, /options\.rawTitle \? title : translateUiText\(title\)/);
  assert.match(html, /options\.rawDescription \? desc : translateUiText\(desc\)/);
  assert.match(html, /dataCard\("Edit cron destination"[\s\S]*rawDescription: true/);
  assert.match(html, /dataCard\(k\.name \|\| k\.id, "", box, \{ rawTitle: true \}\)/);
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*\.locale-control select[\s\S]*min-height: 44px/);
});
