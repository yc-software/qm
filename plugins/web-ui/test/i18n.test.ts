import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { html, installI18n, LOCALE_KEY, normalizeLocale, resolveLocale, translateText } from "../src/i18n.ts";

test("locale resolution prefers the saved choice and otherwise follows the browser", () => {
  assert.equal(normalizeLocale("zh-TW"), "zh-CN");
  assert.equal(normalizeLocale("en-GB"), "en");
  assert.equal(normalizeLocale("fr-FR"), null);
  assert.equal(resolveLocale("en", ["zh-CN"]), "en");
  assert.equal(resolveLocale(null, ["fr-FR", "zh-Hans"]), "zh-CN");
  assert.equal(resolveLocale(null, ["fr-FR"]), "en");
});

test("Chinese translations cover exact UI copy and dynamic counters", () => {
  assert.equal(translateText("New chat", "zh-CN"), "新建对话");
  assert.equal(translateText("  3 tool calls  ", "zh-CN"), "  3 次工具调用  ");
  assert.equal(translateText("New chat in Research", "zh-CN"), "在 Research 中新建对话");
  assert.equal(translateText("Uploading 3 files…", "zh-CN"), "正在上传 3 个文件…");
  assert.equal(translateText("Uploaded 1 file.", "zh-CN"), "已上传 1 个文件。");
  assert.equal(translateText("Uploaded 2 of 3. Server message", "zh-CN"), "已上传 2 / 3。Server message");
  assert.equal(translateText("3 results", "zh-CN"), "3 条结果");
  assert.equal(translateText("2 saved", "zh-CN"), "已保存 2 条");
  assert.equal(translateText("Thinking…", "zh-CN"), "正在思考…");
  assert.equal(translateText("Copy link to Project Alpha", "zh-CN"), "复制 Project Alpha 的链接");
  assert.equal(translateText("More actions for Demo app", "zh-CN"), "Demo app 的更多操作");
  assert.equal(translateText("Handling for Build bot", "zh-CN"), "Build bot 的处理方式");
  assert.equal(translateText("Batch interval for Build bot in hours", "zh-CN"), "Build bot 的批处理间隔（小时）");
  assert.equal(translateText("Remove Build bot from the ledger", "zh-CN"), "从记录中移除 Build bot");
  assert.equal(translateText("read-only", "zh-CN"), "只读");
  assert.equal(translateText("pinned", "zh-CN"), "已置顶");
  assert.equal(translateText("Open here", "zh-CN"), "在此打开");
  assert.equal(translateText("New chat", "en"), "New chat");
  assert.equal(translateText("User supplied content", "zh-CN"), "User supplied content");
});

test("template localization translates authored UI copy and preserves every dynamic value", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8129/" });
  dom.window.localStorage.setItem(LOCALE_KEY, "zh-CN");
  const names = ["document", "localStorage", "navigator"] as const;
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  try {
    installI18n(dom.window.document.documentElement);
    const conversationTitle = "Files";
    const slackMessage = "New chat";
    const template = html`<button title="Sign out">New chat</button>
      <h1 class="chat-title">${conversationTitle}</h1>
      <div class="sm-text">${slackMessage}</div>` as unknown as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    assert.equal(dom.window.document.documentElement.lang, "zh-CN");
    assert.match(template.strings.join(""), /title="退出登录">新建对话/);
    assert.deepEqual(template.values, ["Files", "New chat"]);

    const boundaries = html`<span>Pinned</span><span>Allow once</span><span>Allow custom</span>` as unknown as {
      strings: readonly string[];
    };
    assert.match(boundaries.strings.join(""), /<span>已置顶<\/span><span>允许一次<\/span><span>Allow custom<\/span>/);
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    dom.window.close();
  }
});

test("conditional interface labels pass through the translator", () => {
  const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  assert.match(source("crons.ts"), /t\(showDisabledCrons \? "Hide disabled" : "Show disabled"\)/);
  assert.match(source("contexts.ts"), /t\(contextsState\.createSaving \? "Close" : "Cancel"\)/);
  assert.match(source("sessions.ts"), /title=\$\{t\(s\.archived \? "Unarchive" : "Archive"\)\}/);
  assert.match(source("shell.ts"), /t\(gate\.pending \? "Signing in…" : "Continue"\)/);
  assert.match(source("deploys.ts"), /t\(manage \? "Can manage" : "Can view"\)/);
  assert.match(source("skills.ts"), /t\(deleting === skill\.id \? "Archiving…" : "Archive skill"\)/);
  assert.match(source("memory.ts"), /t\(rawEditing \? "Facts view" : "Edit notebook"\)/);
  assert.match(source("connectors.ts"), /t\(keychainOperations\.dropInFlight \? "Preparing…" : "Continue"\)/);
  assert.match(source("ambient-policy.ts"), /t\(ambientPolicyState\.saving \? "Saving…" : "Save"\)/);
  assert.match(source("context-model.ts"), /message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("context-model.ts"), /t\(contextModelState\.notice\)/);
  assert.match(source("files.ts"), /<span>\$\{t\(dropLabel\)\}<\/span>/);
  assert.match(source("files.ts"), /return message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("files.ts"), /t\(status\)/);
  assert.match(source("connectors.ts"), /t\(status === "connected" \? "connected\." : "connection failed\."\)/);
  assert.match(source("contexts.ts"), /aria-label=\$\{`\$\{t\("Remove"\)\} \$\{label\}`\}/);
  assert.match(source("chat.ts"), /return t\(work\.status === "working" \? `Working for \$\{secs\}s`/);
  assert.match(source("chat.ts"), /return t\("Needs your approval"\)/);
  assert.match(source("chat.ts"), /t\(`\$\{result\.count\} result/);
  assert.match(source("memory.ts"), /memoryNotice = t\("Saved ✓"\)/);
  assert.match(source("memory.ts"), /memoryNotice \|\| t\("Loading…"\)/);
  assert.match(source("contexts.ts"), /contextsNotice \|\| \(contextsLoading[^]*t\("Loading projects…"\)/);
  assert.match(source("skills.ts"), /skillsNotice = t\("Loading skill instructions…"\)/);
  assert.match(source("crons.ts"), /cronActionNotice = t\("Run started\./);
  assert.match(source("connectors.ts"), /`\$\{t\("a Slack channel"\)\} \(\$\{ref\}\)`/);
  assert.match(source("connectors.ts"), /return message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("connectors.ts"), /t\(connectorNotice\)/);
  assert.match(source("connectors.ts"), /title: `\$\{t\("Delete"\)\} \$\{credential\.service\}\?`/);
  assert.match(source("connectors.ts"), /action: t\("Disconnect account"\)/);
  assert.match(source("chat.ts"), /bgPanel\.error = message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("chat.ts"), /t\(bgPanel\.error\)/);
  assert.match(source("files.ts"), /<span>\$\{t\(label\)\}<\/span>/);
  assert.match(source("files.ts"), /<span class="badge">\$\{t\(f\.kind\)\}<\/span>/);
  assert.match(source("sessions.ts"), /aria-label=\$\{t\(`Copy link to \$\{sessionTitle\(s\)\}`\)\}/);
  assert.match(source("deploys.ts"), /aria-label=\$\{t\(`More actions for \$\{deploymentTitle\(d\)\}`\)\}/);
  assert.match(source("ambient-policy.ts"), /ariaLabel: t\(`Handling for \$\{b\.name\}`\)/);
  assert.match(source("composer.ts"), /const steerTitle = t\(/);
  assert.match(source("crons.ts"), /error\.textContent = t\(taskControl \? "Title and task are required\."/);
  assert.match(source("session-list.ts"), /parts\.push\(t\(`\$\{jobs\} background job/);
  assert.match(source("sessions.ts"), /working \? t\("agent is working"\) : null/);
  assert.match(source("sessions.ts"), /aria-label=\$\{t\(ariaLabel\)\}/);
  assert.match(source("split.ts"), /<span>\$\{t\(label\)\}<\/span>/);
  assert.match(source("split.ts"), /if \(panelParams\(panel\)\.sessionId\) return t\("Conversation"\)/);
  assert.match(source("split.ts"), /title=\$\{t\(b\.label\)\}/);
  assert.match(source("chat.ts"), /title = t\(liveWorkExpanded \? "Show less" : "Show more"\)/);
  assert.match(source("chat.ts"), /<strong>\$\{label\}<\/strong> \$\{t\("context"\)\}/);
});
