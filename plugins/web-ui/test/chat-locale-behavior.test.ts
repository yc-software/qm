import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createViteTestServer } from "./vite-test-server.ts";

const dom = new JSDOM(
  '<!doctype html><meta name="qm-locale" content="en"><div id="app"></div><main id="main"></main>',
  { url: "http://localhost/web-ui/" },
);
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
  HTMLDialogElement: dom.window.HTMLDialogElement,
  customElements: dom.window.customElements,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  SubmitEvent: dom.window.SubmitEvent,
  InputEvent: dom.window.InputEvent,
  DOMParser: dom.window.DOMParser,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let contextsResponse: unknown = { contexts: [] };

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = String(input);
  if (path.startsWith("/api/contexts")) return response(contextsResponse);
  if (path.startsWith("/api/crons")) return response({ crons: [], visible: [] });
  if (path.startsWith("/api/runs/active")) return response({});
  if (path.startsWith("/api/runtime-config"))
    return response({
      scopeId: "personal:alice",
      approvedHarnesses: ["claude"],
      modelsByHarness: { claude: ["claude-sonnet-5"] },
      modelCatalog: {},
      orgDefault: { harnessId: "claude", modelId: "claude-sonnet-5", revision: 1 },
      scopeOverride: null,
      effective: { harnessId: "claude", modelId: "claude-sonnet-5" },
      upgradeAvailable: false,
    });
  return response({});
}) as typeof fetch;

const vite = await createViteTestServer();
const { render } = await vite.ssrLoadModule("lit");
const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
const { openSession, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
const { contextsState, renderContexts, scopeChip } = await vite.ssrLoadModule("/src/contexts.ts");
const { ambientPolicyState } = await vite.ssrLoadModule("/src/ambient-policy.ts");
const { chatState, drawActiveChat, newChat } = await vite.ssrLoadModule("/src/chat.ts");
const { renderCronsPage } = await vite.ssrLoadModule("/src/crons.ts");

appState.me = { user: "alice", org: "acme" };
appState.mainEl = document.querySelector("#main");

function selectLocale(selected: "en" | "ja"): void {
  document.querySelector<HTMLMetaElement>('meta[name="qm-locale"]')!.content = selected;
}

function resetNewUser(): void {
  sessionsState.list = [];
  sessionsState.loaded = false;
}

test.after(async () => {
  await vite.close();
});

test("the first-use welcome renders the selected language", () => {
  const expected = {
    en:
      "Hi — I'm your AI teammate 👋\n\n" +
      "I run tasks on a computer of my own and work across your connected tools — Slack, Google Workspace, GitHub, Linear, and the open web — and I remember what we work on together.\n\n" +
      "Want to get set up? Tell me your name and what you're working on, and I'll take it from there — or just ask me anything to dive straight in.",
    ja:
      "こんにちは。AIチームメイトです 👋\n\n" +
      "専用のコンピューターでタスクを実行し、連携したSlack、Google Workspace、GitHub、Linear、Webを横断して作業します。一緒に取り組んだ内容も覚えています。\n\n" +
      "まず設定しますか？お名前と取り組んでいることを教えてください。あとは私が進めます。すぐに始めたい場合は、そのまま何でも依頼してください。",
  } as const;

  for (const selected of ["en", "ja"] as const) {
    selectLocale(selected);
    resetNewUser();
    newChat();
    const block = appState.mainEl.querySelector(".welcome-greeting markdown-block") as HTMLElement & {
      content?: string;
    };
    assert.equal(block.content, expected[selected], selected);
  }
});

test("Japanese chat context banners name projects, channels, and group DMs accurately", () => {
  selectLocale("ja");
  resetNewUser();

  const cases = [
    {
      context: { scopeId: "project:synthetic-1", name: "Alpha", kind: "project" as const },
      label: "Alphaプロジェクト",
      hint: "このチャットはAlphaプロジェクトで実行されます。",
    },
    {
      context: { scopeId: "channel:C123", name: "general", kind: "channel" as const },
      label: "#general",
      hint: "このチャットは#generalチャンネルで実行されます。",
    },
    {
      context: { scopeId: "group:G123", name: "Alice, Bob", kind: "group" as const },
      label: "Alice, Bob",
      hint: "このチャットはAlice, BobとのグループDMで実行されます。",
    },
  ];

  for (const { context, label, hint } of cases) {
    newChat(context);
    const banner = appState.mainEl.querySelector(".context-banner");
    assert.ok(banner, context.kind);
    assert.equal(banner.textContent?.trim(), label, context.kind);
    assert.match(banner.getAttribute("title") ?? "", new RegExp(`^${hint}`), context.kind);
  }

  newChat();
  assert.equal(appState.mainEl.querySelector(".context-banner"), null, "personal");
});

test("Japanese scope chips identify personal, project, channel, and group DM destinations", () => {
  selectLocale("ja");
  const original = contextsState.list;
  contextsState.list = [
    { scopeId: "personal:alice", kind: "personal", name: null, sessionCount: 0, lastActivityAt: null },
    {
      scopeId: "project:synthetic-1",
      kind: "group",
      name: "mpdm-alice--bob-1",
      sessionCount: 0,
      lastActivityAt: null,
      project: {
        id: "project-alpha",
        name: "Alpha",
        ownerId: "alice",
        memberIds: ["alice"],
        scopeId: "project:synthetic-1",
        members: [{ principalId: "alice", displayName: "Alice" }],
      },
    },
    { scopeId: "channel:C123", kind: "channel", name: "general", sessionCount: 0, lastActivityAt: null },
    { scopeId: "group:G123", kind: "group", name: "Alice, Bob", sessionCount: 0, lastActivityAt: null },
  ];
  const cases = [
    ["personal:alice", "個人: 個人プロジェクト", "個人プロジェクト"],
    ["project:synthetic-1", "プロジェクト: Alpha", "Alpha"],
    ["channel:C123", "チャンネル: #general", "general"],
    ["group:G123", "グループDM: Alice, Bob", "Alice, Bob"],
  ] as const;

  try {
    for (const [scopeId, title, text] of cases) {
      const host = document.createElement("div");
      render(scopeChip(scopeId), host);
      const chip = host.querySelector(".scope-chip");
      assert.ok(chip, scopeId);
      assert.equal(chip.getAttribute("title"), title, scopeId);
      assert.equal(chip.textContent?.trim(), text, scopeId);
    }
  } finally {
    contextsState.list = original;
  }
});

test("opening a project conversation loads context metadata before choosing its label", async () => {
  selectLocale("ja");
  resetNewUser();
  contextsState.list = [];
  contextsState.loaded = false;
  contextsResponse = {
    contexts: [
      {
        scopeId: "project:synthetic-loaded",
        kind: "group",
        name: "mpdm-alice--bob-1",
        sessionCount: 1,
        lastActivityAt: 1,
        project: {
          id: "project-loaded",
          name: "Alpha",
          ownerId: "alice",
          memberIds: ["alice"],
          scopeId: "project:synthetic-loaded",
          members: [{ principalId: "alice", displayName: "Alice" }],
        },
      },
    ],
  };

  try {
    await openSession({
      id: "",
      type: "group",
      scopeId: "project:synthetic-loaded",
      threadRef: "web:alice:project-loaded",
      createdAt: 1,
      channelName: "mpdm-alice--bob-1",
    });
    const banner = appState.mainEl.querySelector(".context-banner");
    assert.ok(banner);
    assert.equal(banner.textContent?.trim(), "Alphaプロジェクト");
  } finally {
    contextsResponse = { contexts: [] };
  }
});

test("Japanese context details name channels and group DMs without calling them projects", async () => {
  selectLocale("ja");
  const cases = [
    {
      context: {
        scopeId: "channel:C-general",
        kind: "channel",
        name: "general",
        sessionCount: 0,
        lastActivityAt: null,
      },
      noun: "チャンネル",
    },
    {
      context: { scopeId: "group:G-team", kind: "group", name: "Alice, Bob", sessionCount: 0, lastActivityAt: null },
      noun: "グループDM",
    },
  ] as const;
  appState.currentView = "contexts";

  try {
    for (const { context, noun } of cases) {
      contextsResponse = { contexts: [context] };
      contextsState.selected = context.scopeId;
      contextsState.resourcesScope = context.scopeId;
      contextsState.resources = { files: [], crons: [], deployments: [], skills: [], manageable: true };
      ambientPolicyState.scope = context.scopeId;
      ambientPolicyState.loading = false;
      await renderContexts();

      assert.match(appState.mainEl.querySelector(".context-sub")?.textContent ?? "", new RegExp(`この${noun}`));
      assert.equal(
        appState.mainEl.querySelector(".context-project-empty h2")?.textContent,
        `この${noun}は作業を開始できます`,
      );
      assert.equal(appState.mainEl.querySelector(".context-settings")?.getAttribute("aria-label"), `${noun}の設定`);
      assert.equal(
        appState.mainEl.querySelector(".ambient-policy .context-panel-copy")?.textContent,
        `この${noun}でエージェントが気付き、対応する内容を設定します。`,
      );
    }
  } finally {
    appState.currentView = "chats";
    contextsState.selected = null;
    contextsState.resourcesScope = null;
    contextsState.resources = null;
    ambientPolicyState.scope = null;
    contextsResponse = { contexts: [] };
  }
});

test("new scheduled-task chat drafts preserve the instruction in both languages", async () => {
  const originalPrompt = Agent.prototype.prompt;
  let prompted = "";
  Agent.prototype.prompt = async function (input: string): Promise<void> {
    prompted = input;
  } as typeof Agent.prototype.prompt;
  try {
    const expected = {
      en: 'Set up a cron for me: Send the unread email summary every weekday at 9am.\n\n(Sent from the web UI\'s New-cron pane — create it now with your scheduling API, use a calendar schedule with timezone for daily/weekly/monthly timing, give it a 2-5 word title naming what the cron is for and distinctive in a list, like "Gmail unread digest" or "GitLab CI watch" — not the command and not a generic word, and confirm what you created.)',
      ja: "次の定期実行を設定してください: Send the unread email summary every weekday at 9am.\n\n（Web UIの「定期実行を作成」画面から送信されました。スケジュールAPIを使って今すぐ作成してください。毎日・毎週・毎月の実行にはタイムゾーン付きのカレンダースケジュールを使用してください。タイトルは、一覧で見分けられるように定期実行の目的を表す2〜5語にしてください。例:「Gmail未読まとめ」「GitLab CI監視」。コマンドそのものや「タスク」のような一般的な語は避け、作成内容を最後に確認してください。）",
    } as const;

    for (const selected of ["en", "ja"] as const) {
      selectLocale(selected);
      appState.currentView = "crons";
      await renderCronsPage();
      const buttons = appState.mainEl.querySelectorAll("button") as NodeListOf<HTMLButtonElement>;
      const create = [...buttons].find((button) =>
        button.textContent?.includes(selected === "ja" ? "定期実行を作成" : "New scheduled task"),
      );
      assert.ok(create, `${selected} create button`);
      create.click();
      const form = appState.mainEl.querySelector("form.cron-form") as HTMLFormElement;
      const textarea = form.querySelector('textarea[name="text"]') as HTMLTextAreaElement;
      textarea.value = "Send the unread email summary every weekday at 9am.";
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      assert.equal(prompted, expected[selected], selected);
    }
  } finally {
    Agent.prototype.prompt = originalPrompt;
  }
});

test("approval work visibility follows semantic denial state instead of rendered text", () => {
  selectLocale("en");
  resetNewUser();
  newChat();
  const agent = chatState.agent;
  assert.ok(agent);
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Denied." }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: {},
    stopReason: "stop",
    timestamp: 1,
    work: {
      status: "complete",
      activity: [
        {
          seq: 1,
          parentSeq: null,
          type: "tool_call",
          payload: { tool: "execute", command: "git push" },
          createdAt: 1,
        },
      ],
    },
  };

  agent.state.messages = [message];
  drawActiveChat(agent);
  assert.ok(appState.mainEl.querySelector(".work"), "matching presentation text alone must not suppress work");

  selectLocale("ja");
  agent.state.messages = [
    {
      ...message,
      content: [{ type: "text", text: "承認を拒否しました。" }],
      approvalDecision: "denied",
    },
  ];
  drawActiveChat(agent);
  assert.equal(appState.mainEl.querySelector(".work"), null, "semantic denial suppresses approval work in any locale");
});
