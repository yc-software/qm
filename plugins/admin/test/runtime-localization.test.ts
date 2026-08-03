import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { ADMIN_MESSAGES, type AdminMessageKey } from "../src/messages.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function functionSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const open = html.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = open; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(`${name} closes`);
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = { toggle() {} };
  readonly content = { textContent: "" };
  textContent = "";
  value: string | number = "";
  disabled = false;
  type = "";
  className = "";
  placeholder = "";
  min = "";
  step = "";
  spellcheck = false;
  onchange: (() => void) | null = null;

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  setAttribute(): void {}
  addEventListener(): void {}
  requestSubmit(): void {}
}

function runtimeMessages(locale: "en" | "ja"): Record<string, string> {
  const views = [
    "onboarding",
    "governance",
    "connectors",
    "users",
    "keychain",
    "user",
    "metrics",
    "egress",
    "history",
    "files",
    "memory",
    "live",
    "audit",
    "skills",
    "crons",
    "deployments",
    "retention",
    "slack",
    "judgments",
    "ackemoji",
  ];
  const messages = Object.fromEntries(views.map((view) => [`view.${view}`, view]));
  return {
    ...messages,
    adminTitle: "{brand} Admin",
    pageControls: "controls",
    "common.allow": "allow",
    "common.deny": "deny",
    "common.requireApproval": "approval",
    "action.remove": "remove",
    "time.now": locale === "ja" ? "今" : "now",
    "time.minute": "{count}",
    "time.minutes": "{count}",
    "time.today": "{time}",
    "time.yesterday": "{time}",
    "crons.dailyAt": "{time}",
    "crons.weekdaysAt": "{time}",
    "crons.daysAt": "{days} {time}",
    "crons.hourly": "hourly",
    "crons.hourlyAt": "{minute}",
    ...Object.fromEntries(Array.from({ length: 7 }, (_, day) => [`crons.day${day}`, String(day)])),
    "history.conversationCount": locale === "ja" ? "会話 {count}件" : "{count} conversation(s)",
    "history.backgroundCount": locale === "ja" ? "バックグラウンド {count}件" : "{count} background run(s)",
    "history.noConversations": locale === "ja" ? "会話なし" : "no conversations",
    "governance.botMode.ignore": locale === "ja" ? "無視 — 判定を起動しない" : "ignore — never wakes the judge",
    "governance.botMode.rollup": locale === "ja" ? "集約 — 定期的にまとめて判定" : "rollup — batch, judge periodically",
    "governance.botMode.action": locale === "ja" ? "操作 — 投稿を起点にする" : "action — posts are triggers",
    "governance.botMode.user": locale === "ja" ? "利用者 — 人の投稿として読む" : "user — read like a person",
    "governance.botNamePlaceholder": "name",
    "governance.removeBot": "remove bot",
  };
}

function createRuntime(locale: "en" | "ja", defaultLocale: string): vm.Context {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id) as FakeElement;
  };
  element("locale-messages").content.textContent = JSON.stringify(runtimeMessages(locale));
  class TrackingDate extends Date {
    constructor(
      value?: string | number | Date,
      month?: number,
      date?: number,
      hours?: number,
      minutes?: number,
      seconds?: number,
      milliseconds?: number,
    ) {
      if (arguments.length === 0) super("2024-01-02T12:00:00Z");
      else if (arguments.length === 1) super(value as string | number | Date);
      else super(value as number, month ?? 0, date ?? 1, hours ?? 0, minutes ?? 0, seconds ?? 0, milliseconds ?? 0);
    }

    toLocaleString(selected?: string | string[]): string {
      return `date:${selected || defaultLocale}`;
    }

    toLocaleTimeString(selected?: string | string[]): string {
      return `time:${selected || defaultLocale}`;
    }

    toLocaleDateString(selected?: string | string[]): string {
      return `day:${selected || defaultLocale}`;
    }
  }
  const document = {
    documentElement: { lang: locale },
    title: "",
    getElementById: element,
    querySelector: () => ({ getAttribute: () => "Agent" }),
    createElement: () => new FakeElement(),
  };
  const context = vm.createContext({
    URLSearchParams,
    Date: TrackingDate,
    document,
    location: { pathname: "/admin", search: "", hash: "" },
    window: { open() {} },
    alert() {},
    fetch,
    __defaultLocale: defaultLocale,
  });
  vm.runInContext(
    'Number.prototype.toLocaleString = function (selected) { return "number:" + (selected || globalThis.__defaultLocale); }',
    context,
  );
  const start = html.indexOf("      const $ = (id)");
  const end = html.indexOf("      const fmtMs =", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(
    `${html.slice(start, end)}; globalThis.__formatters = { fmtTime, fmtClock, relTime, fmtHistoryCreated };`,
    context,
  );
  return context;
}

for (const [locale, defaultLocale, intlLocale] of [
  ["ja", "en-US", "ja-JP"],
  ["en", "ja-JP", "en-US"],
] as const) {
  test(`${locale} document locale drives Admin date, number, relative-time, and cron output`, () => {
    const context = createRuntime(locale, defaultLocale);
    const output = vm.runInContext(
      `({
        full: __formatters.fmtTime("2020-01-01T00:00:00Z"),
        clock: __formatters.fmtClock(new Date("2020-01-01T00:00:00Z")),
        relativeDate: __formatters.relTime("2020-01-01T00:00:00Z"),
        relativeNumber: __formatters.relTime("2024-01-02T11:30:00Z")
      })`,
      context,
    ) as Record<string, string>;
    assert.equal(output.full, `date:${intlLocale}`);
    assert.equal(output.clock, `time:${intlLocale}`);
    assert.match(output.relativeDate, new RegExp(`day:${intlLocale}.*time:${intlLocale}`));
    assert.equal(output.relativeNumber, `number:${intlLocale}`);

    vm.runInContext(
      `${functionSource("cronFieldSet")}\n${functionSource("humanCron")}\nglobalThis.__humanCron = humanCron;`,
      context,
    );
    assert.equal(vm.runInContext('__humanCron("5 9 * * *")', context), `time:${intlLocale}`);
  });
}

test("Japanese runtime localizes session counts and empty state", () => {
  const context = createRuntime("ja", "en-US");
  vm.runInContext(
    `${functionSource("sessionCountsLabel")}\nglobalThis.__sessionCountsLabel = sessionCountsLabel;`,
    context,
  );
  assert.equal(
    vm.runInContext("__sessionCountsLabel(2, 3)", context),
    "会話 number:ja-JP件 · バックグラウンド number:ja-JP件",
  );
  assert.equal(vm.runInContext("__sessionCountsLabel(0, 0)", context), "会話なし");
});

test("Japanese runtime renders localized bot behavior options", () => {
  const context = createRuntime("ja", "en-US");
  const start = html.indexOf("      const BOT_MODES =");
  const end = html.indexOf("      function syncBotsEmpty()", start);
  vm.runInContext(`${html.slice(start, end)}\n${functionSource("botRow")}\nglobalThis.__botRow = botRow;`, context);
  const row = vm.runInContext('__botRow("helper", { mode: "ignore" })', context) as FakeElement;
  const options = row.children[1].children[0].children.map((option) => option.textContent);
  assert.deepEqual(options, [
    "無視 — 判定を起動しない",
    "集約 — 定期的にまとめて判定",
    "操作 — 投稿を起点にする",
    "利用者 — 人の投稿として読む",
  ]);
});

test("Japanese catalogs cover representative dynamic Admin state and count copy", () => {
  const expected = {
    "metrics.runCount": "実行 {count}件",
    "metrics.failureRate": "失敗率 {rate}",
    "users.fileSourceAgent": "エージェント",
    "users.fileSourceUpload": "アップロード",
    "deployments.versionCount": "{count}版",
    "slack.peopleCount": "{count}人",
    "slack.mirrorSummary": "ミラー済み {messages}件 · メンバー {members}人",
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    assert.equal((ADMIN_MESSAGES.ja as Record<string, string>)[key as AdminMessageKey], value);
  }
});
