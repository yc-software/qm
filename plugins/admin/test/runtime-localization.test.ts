import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { ADMIN_MESSAGES } from "../src/messages.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function functionSource(name: string): string {
  const functionStart = html.indexOf(`function ${name}(`);
  assert.ok(functionStart >= 0, `${name} exists`);
  const start = html.slice(functionStart - 6, functionStart) === "async " ? functionStart - 6 : functionStart;
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
  readonly classList = {
    toggle() {},
    add() {},
    contains() {
      return false;
    },
  };
  readonly content = { textContent: "" };
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly nodeType = 1;
  textContent = "";
  value: string | number = "";
  disabled = false;
  type = "";
  className = "";
  placeholder = "";
  title = "";
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

  prepend(...children: FakeElement[]): void {
    this.children.unshift(...children);
  }

  querySelector(): FakeElement {
    return new FakeElement();
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  requestSubmit(): void {}
}

function createRuntime(locale: "en" | "ja", defaultLocale: string): vm.Context {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id) as FakeElement;
  };
  element("locale-messages").content.textContent = JSON.stringify(ADMIN_MESSAGES[locale]);
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
    assert.equal(output.relativeNumber, locale === "ja" ? `number:${intlLocale}分前` : `number:${intlLocale} mins`);

    vm.runInContext(
      `${functionSource("cronFieldSet")}\n${functionSource("humanCron")}\nglobalThis.__humanCron = humanCron;`,
      context,
    );
    assert.equal(
      vm.runInContext('__humanCron("5 9 * * *")', context),
      locale === "ja" ? `毎日 time:${intlLocale}` : `daily time:${intlLocale}`,
    );
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

test("Japanese metrics renderer uses localized labels and ja-JP counts", () => {
  const context = createRuntime("ja", "en-US");
  vm.runInContext(
    `globalThis.urlToState = () => ({});
     globalThis.renderTurnMix = () => {};
     globalThis.openableTable = () => document.createElement("div");
     globalThis.nodeCell = (value) => value;
     globalThis.stacked = (...values) => values.join(" | ");
     globalThis.phaseLabel = (value) => value;
     globalThis.phaseDesc = () => "";
     globalThis.fmtPct = (value) => String((value || 0) * 100) + "%";
     globalThis.fmtTokens = (value) => fmtNumber(value);
     globalThis.sparkline = () => document.createElement("div");
     globalThis.go = () => {};
     globalThis.statline = (parts) => {
       const node = document.createElement("div");
       node.textContent = parts.join(" | ");
       return node;
     };`,
    context,
  );
  vm.runInContext(
    `${functionSource("renderCacheHealth")}\n${functionSource("renderMetrics")}\nglobalThis.__renderMetrics = renderMetrics;`,
    context,
  );
  const root = new FakeElement();
  Object.assign(context, { __root: root });
  vm.runInContext(
    `__renderMetrics(__root, {
       phases: [],
       throughput: { total: 12345, done: 12000, failed: 345, failureRate: 0.028 },
       cache: { samples: 12345, missTurns: 345, avgHitRatio: 0.9, pooledHitRatio: 0.8, missRate: 0.1 }
     })`,
    context,
  );
  assert.deepEqual(root.children.map((child) => child.textContent).filter(Boolean), [
    "プロンプトキャッシュのヒット率 90% | トークン加重 80% | 安定した接頭辞のミス率 10% | キャッシュミス number:ja-JP件 | キャッシュデータあり number:ja-JP件 | 読み取り number:ja-JP | 書き込み number:ja-JP",
    "実行 number:ja-JP件 | 完了 number:ja-JP件 | 失敗 number:ja-JP件 | 失敗率 2.8000000000000003%",
  ]);
});

test("Japanese user renderer localizes fallback copy and every displayed count", async () => {
  const context = createRuntime("ja", "en-US");
  const tables: Array<{ headers: unknown[]; rows: unknown[][] }> = [];
  const kpiValues: unknown[][][] = [];
  const userData = {
    principalId: "U1",
    displayName: "利用者",
    scopeId: "personal:U1",
    stats: { sessions: 12345, turns: 23456 },
    conversations: [],
    files: [{ name: "README", path: "README", size: 0, direction: "out", openable: false }],
    deployments: [],
    crons: [],
    config: {
      commandPolicy: { mode: "denylist", rules: Array.from({ length: 12345 }, () => ({})) },
      egress: {
        allowedHosts: Array.from({ length: 12345 }, () => "allowed.example"),
        deniedHosts: Array.from({ length: 23456 }, () => "denied.example"),
      },
      connectors: Array.from({ length: 12345 }, () => ({})),
      securityPosture: "auto",
    },
    onboarding: "not_started",
  };
  Object.assign(context, { __tables: tables, __kpis: kpiValues, __userData: userData });
  vm.runInContext(
    `globalThis.api = async () => ({ ok: true, data: globalThis.__userData });
     globalThis.pageShell = () => {};
     globalThis.webUiAsButton = () => document.createElement("button");
     globalThis.kpis = (items) => {
       globalThis.__kpis.push(items);
       return document.createElement("div");
     };
     globalThis.openableTable = (headers, items, rowOf) => {
       globalThis.__tables.push({ headers, rows: items.map(rowOf) });
       return document.createElement("div");
     };
     globalThis.table = (headers, rows) => {
       globalThis.__tables.push({ headers, rows });
       return document.createElement("div");
     };
     globalThis.dataCard = () => document.createElement("div");
     globalThis.nodeCell = (value) => value;
     globalThis.stacked = (...values) => values.filter(Boolean).join(" | ");
     globalThis.mutedText = (value) => String(value);
     globalThis.historyScopeCell = (value) => value;
     globalThis.fmtHistoryTime = () => "時刻";
     globalThis.fmtHistoryCreated = () => "作成時刻";
     globalThis.fmtBytes = () => "0 B";
     globalThis.deploymentHref = () => "";
     globalThis.statusBadge = () => document.createElement("span");
     globalThis.fmtSchedule = () => "—";
     globalThis.cronStatusText = () => "";
     globalThis.badge = () => document.createElement("span");
     globalThis.go = () => {};
     globalThis.history = { back() {} };
     globalThis.confirm = () => false;`,
    context,
  );
  vm.runInContext(
    `${functionSource("fileKind")}\n${functionSource("showUserDetail")}\nglobalThis.__showUserDetail = showUserDetail;`,
    context,
  );
  await vm.runInContext('__showUserDetail("U1")', context);
  const rows = tables.flatMap((entry) => entry.rows);
  const configValue = (label: string) => rows.find((row) => row[0] === label)?.[1];
  const fileKindCell = rows.find((row) => (row[0] as string)?.includes?.("README"))?.[1] as { text?: string };
  assert.deepEqual(
    {
      sessionCount: kpiValues[0]?.[0]?.[0],
      turnCount: kpiValues[0]?.[1]?.[0],
      fileKind: fileKindCell?.text,
      commandPolicy: configValue("コマンドポリシー"),
      egress: configValue("外部通信の上書き"),
      connectors: configValue("接続済みコネクター"),
    },
    {
      sessionCount: "number:ja-JP",
      turnCount: "number:ja-JP",
      fileKind: "ファイル",
      commandPolicy: "ルール number:ja-JP件 · denylist",
      egress: "許可number:ja-JP件、拒否number:ja-JP件",
      connectors: "number:ja-JP",
    },
  );
});

test("Japanese Slack renderer formats its visible container count", async () => {
  const context = createRuntime("ja", "en-US");
  const containers = [
    { container: "G1", kind: "group", members: ["U1", "U2"], messageCount: 12345, updatedAt: 0 },
    ...Array.from({ length: 1233 }, (_, index) => ({
      container: `C${index}`,
      kind: "channel",
      name: `channel-${index}`,
      members: [],
      messageCount: 0,
      updatedAt: 0,
    })),
  ];
  const shells: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, unknown>> = [];
  Object.assign(context, { __containers: containers, __shells: shells, __slackRows: rows });
  vm.runInContext(
    `let slackReq = 0;
     let slackContainers = globalThis.__containers;
     view = "slack";
     globalThis.loadSlackContainers = async () => ({ ok: true });
     globalThis.urlToState = () => ({});
     globalThis.slackSearchBox = () => ({});
     globalThis.pageShell = (options) => globalThis.__shells.push(options);
     globalThis.denseList = (items, rowOf) => {
       globalThis.__slackRows.push(rowOf(items[0]));
       return document.createElement("div");
     };
     globalThis.stateToUrl = () => "/admin/slack";
     globalThis.go = () => {};`,
    context,
  );
  vm.runInContext(
    `${functionSource("slackContainerMeta")}\n${functionSource("slackContainerLabel")}\n${functionSource("slackContainerScope")}\n${functionSource("renderSlackMirror")}\nglobalThis.__renderSlackMirror = renderSlackMirror;`,
    context,
  );
  await vm.runInContext("__renderSlackMirror({})", context);
  assert.deepEqual(
    { count: shells.at(-1)?.count, name: rows[0]?.name, preview: rows[0]?.preview },
    {
      count: "number:ja-JP",
      name: "number:ja-JP人",
      preview: "ミラー済み number:ja-JP件 · メンバー number:ja-JP人",
    },
  );
});

test("Japanese keychain and skill renderers localize fallback copy and counts", () => {
  const context = createRuntime("ja", "en-US");
  const tables: Array<{ headers: unknown[]; rows: unknown[][] }> = [];
  const shells: Array<Record<string, unknown>> = [];
  Object.assign(context, { __tables: tables, __shells: shells });
  vm.runInContext(
    `globalThis.defaultShell = (options) => globalThis.__shells.push(options);
     globalThis.table = (headers, rows) => {
       globalThis.__tables.push({ headers, rows });
       return document.createElement("div");
     };
     globalThis.dataCard = (_title, _body, content) => content;
     globalThis.nodeCell = (value) => value;
     globalThis.stacked = (...values) => values.filter(Boolean).join(" | ");
     globalThis.mutedText = (value) => String(value);
     globalThis.badge = () => document.createElement("span");
     globalThis.shortId = (value, length = 8) => String(value || "").slice(0, length);`,
    context,
  );
  vm.runInContext(
    `${functionSource("scopeKind")}\n${functionSource("keychainGrantStatus")}\n${functionSource("keychainExpiry")}\n${functionSource("keychainPersonLabel")}\n${functionSource("renderKeychain")}\n${functionSource("packRepoLabel")}\n${functionSource("createdByCell")}\nglobalThis.__renderKeychain = renderKeychain; globalThis.__createdByCell = createdByCell;`,
    context,
  );
  const root = new FakeElement();
  Object.assign(context, { __root: root });
  vm.runInContext(
    `__renderKeychain(__root, {
       people: [{ principalId: "U1", credentialCount: 12345, activeGrantCount: 12345, pendingAskCount: 12345 }],
       credentials: [{ id: "cred", ownerId: "U1", service: "service", kind: "token", targets: [] }],
       grants: [
         { ownerId: "U1", credentialId: "cred", audienceScopeId: "org:o", mode: "once", status: "used", purpose: "目的", usedBy: "U2" },
         { ownerId: "U1", credentialId: "cred", audienceScopeId: "org:o", mode: "once", status: "active", purpose: "別目的", askId: "A1" }
       ],
       asks: []
     })`,
    context,
  );
  const rows = tables.flatMap((entry) => entry.rows);
  const peopleRow = rows.find((row) => row[0] === "U1");
  const grantRow = rows.find((row) => (row.at(-1) as string)?.startsWith?.("目的"));
  const askGrantRow = rows.find((row) => (row.at(-1) as string)?.startsWith?.("別目的"));
  assert.deepEqual(
    {
      pack: vm.runInContext('__createdByCell({ pack: { url: "", id: "abcdefghi" } }).text', context),
      shellCounts: Array.from(shells[0]?.stats as unknown[][], (entry) => entry[0]),
      personCounts: Array.from(peopleRow?.slice(1) || [], (cell) => (cell as { text?: string }).text),
      purpose: grantRow?.at(-1),
      askPurpose: askGrantRow?.at(-1),
    },
    {
      pack: "パック abcdefgh",
      shellCounts: ["number:ja-JP", "number:ja-JP", "number:ja-JP", "number:ja-JP"],
      personCounts: ["number:ja-JP", "number:ja-JP", "number:ja-JP"],
      purpose: "目的 | 使用者 U2",
      askPurpose: "別目的 | 申請 A1",
    },
  );
});

test("Japanese skills renderer formats every visible sync count", async () => {
  const context = createRuntime("ja", "en-US");
  const packRows: unknown[][] = [];
  const pack = {
    id: "pack-1",
    url: "https://github.com/acme/skills.git",
    trustTier: "internal",
    syncMode: "pinned",
    available: 12345,
    importedCount: 12345,
    lastImport: {
      status: "ok",
      counts: { imported: 12345, updated: 12345, skipped: 12345, archived: 12345 },
    },
  };
  Object.assign(context, { __pack: pack, __packRows: packRows });
  vm.runInContext(
    `view = "skills";
     scope = "org:acme";
     globalThis.orgWideView = () => true;
     globalThis.orgOwnView = () => false;
     globalThis.groupSkillsByIdentity = () => [];
     globalThis.scopeIndexList = () => document.createElement("div");
     globalThis.openableTable = () => document.createElement("table");
     globalThis.wireScopeSearch = () => {};
     globalThis.bareDataCard = (value) => value;
     globalThis.table = (_headers, rows) => {
       globalThis.__packRows.push(...rows);
       return document.createElement("table");
     };
     globalThis.closeOvMenus = () => {};
     globalThis.browsePack = () => {};
     globalThis.dataCache = { clear() {} };
     globalThis.renderData = () => {};
     globalThis.setTimeout = () => 0;
     globalThis.api = async (method) =>
       method === "POST"
         ? {
             ok: true,
             data: {
               imported: Array(12345).fill("new"),
               updated: Array(12345).fill("updated"),
               archived: Array(12345).fill("archived")
             }
           }
         : { ok: false, data: {} };`,
    context,
  );
  vm.runInContext(
    `${functionSource("packRepoLabel")}
     ${functionSource("overflowMenu")}
     ${functionSource("renderPacksSection")}
     globalThis.fillPacksSection = (holder) => {
       renderPacksSection(holder, [globalThis.__pack]);
     };
     ${functionSource("renderSkills")}
     globalThis.__renderSkills = renderSkills;`,
    context,
  );
  const root = new FakeElement();
  Object.assign(context, { __root: root });
  vm.runInContext("__renderSkills(__root, { skills: [] })", context);
  const packNode = (packRows[0]?.[0] as { node?: FakeElement })?.node;
  const statusNode = (packRows[0]?.[3] as { node?: FakeElement })?.node;
  const menuWrap = (packRows[0]?.[4] as { node?: FakeElement })?.node;
  const syncButton = menuWrap?.children[1]?.children.find((button) => button.textContent === "今すぐ同期");
  assert.ok(syncButton, "sync action rendered");
  (syncButton as unknown as { onclick(event: { stopPropagation(): void }): void }).onclick({ stopPropagation() {} });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    {
      packTitle: packNode?.title,
      lastSync: statusNode?.title,
      immediateSync: statusNode?.textContent,
    },
    {
      packTitle:
        "https://github.com/acme/skills.git\n最終同期: 新規number:ja-JP件、更新number:ja-JP件、スキップnumber:ja-JP件、削除number:ja-JP件",
      lastSync: "最終同期: 新規number:ja-JP件、更新number:ja-JP件、スキップnumber:ja-JP件、削除number:ja-JP件",
      immediateSync: "✓ 新規number:ja-JP件、更新number:ja-JP件、削除number:ja-JP件",
    },
  );
});
