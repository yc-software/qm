import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

const person = (principalId: string, costUsd: number, over: Record<string, any> = {}) => ({
  principalId,
  scopeId: `personal:${principalId}`,
  kind: "person",
  displayName: "",
  costUsd,
  calls: 2,
  tokens: 1000,
  input: 100,
  output: 100,
  cacheRead: 700,
  cacheWrite: 100,
  cacheHitRatio: 0.7,
  live: { costUsd, calls: 2, tokens: 1000 },
  cron: { costUsd: 0, calls: 0, tokens: 0 },
  background: { costUsd: 0, calls: 0, tokens: 0 },
  ...over,
});

const DATA = {
  window: { from: "2026-08-26", to: "2026-09-25", bucket: "day" },
  org: {
    costUsd: 16,
    calls: 8,
    tokens: 4000,
    input: 400,
    output: 400,
    cacheRead: 2800,
    cacheWrite: 400,
    cacheHitRatio: 0.7,
    live: { costUsd: 16, calls: 8, tokens: 4000 },
    cron: { costUsd: 0, calls: 0, tokens: 0 },
    background: { costUsd: 0, calls: 0, tokens: 0 },
  },
  series: [
    { day: "2026-09-23", costUsd: 6, calls: 4, live: { costUsd: 6 }, cron: { costUsd: 0 }, background: { costUsd: 0 } },
    {
      day: "2026-09-24",
      costUsd: 10,
      calls: 4,
      live: { costUsd: 10 },
      cron: { costUsd: 0 },
      background: { costUsd: 0 },
    },
  ],
  people: [person("alice", 5), person("bob", 10), person("carol", 1)],
  scopes: [person("", 0, { principalId: null, scopeId: "channel:C1", kind: "channel", displayName: "#general" })],
};

const EMPTY = {
  window: { from: "2026-08-26", to: "2026-09-25", bucket: "day" },
  org: {
    costUsd: 0,
    calls: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheHitRatio: null,
    live: { costUsd: 0, calls: 0, tokens: 0 },
    cron: { costUsd: 0, calls: 0, tokens: 0 },
    background: { costUsd: 0, calls: 0, tokens: 0 },
  },
  series: [],
  people: [],
  scopes: [],
};

function render(data: any, services: Record<string, unknown> = {}) {
  const f = litFixture();
  const calls: any = { shell: null, ranges: [], customs: [], opened: [], downloads: 0, modelDownloads: 0, api: 0 };
  const view = f.ui.spend.spend(f.root, data, {
    range: "30d",
    defaultShell: (opts: any) => {
      calls.shell = opts;
    },
    api: () => {
      calls.api += 1;
      return Promise.resolve({ ok: true, data: {} });
    },
    fmtPct: (n: number) => (n * 100).toFixed(1) + "%",
    fmtTokens: (n: number) => `${n} tokens`,
    shortName: String,
    plural: (n: number, one: string) => `${n} ${one}`,
    openUser: (principal: string) => calls.opened.push(principal),
    setRange: (range: string) => calls.ranges.push(range),
    setCustomRange: (from: string, to: string) => calls.customs.push([from, to]),
    downloadCsv: (breakdown?: string) => {
      if (breakdown === "model") calls.modelDownloads += 1;
      else calls.downloads += 1;
    },
    ...services,
  });
  const peopleRows = () =>
    [...f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll("tbody tr")].map((r) =>
      r.querySelector("td")!.textContent!.trim(),
    );
  return { f, calls, view, peopleRows };
}

test("spend view: shows the saved report freshness", () => {
  const { f } = render({ ...DATA, asOf: Date.UTC(2026, 8, 25, 12) });
  assert.match(f.root.textContent!, /Totals as of.*Updated every minute/);
  f.window.close();
});

test("spend view: KPI stats, stacked chart and range tabs describe the whole org", () => {
  const { f, calls } = render(DATA);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.stats)), [
    ["$16.00", "Total spend"],
    ["$16.00", "Live"],
    ["$0.00", "Crons"],
    ["70.0%", "Cache hit rate"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.tabs.map((t: any) => [t.label, t.active]))), [
    ["7d", false],
    ["30d", true],
    ["90d", false],
    ["Custom", false],
  ]);
  assert.equal(f.root.querySelectorAll(".spend-column").length, 30, "zero-spend dates retain their space");
  assert.ok(f.root.textContent!.includes("$0.53"), "daily average includes zero-spend days");
  const bar = f.root.querySelectorAll<HTMLElement>(".spend-column")[29]!;
  bar.dispatchEvent(new f.window.Event("pointerenter"));
  assert.match(f.root.querySelector(".spend-chart-detail")!.textContent!, /Sep 24.*\$10.00 total.*Live \$10.00/);
  assert.equal(bar.querySelector<HTMLElement>(".spend-live")!.style.height, "100%");
  calls.shell.tabs[0].onClick();
  assert.deepEqual(calls.ranges, ["7d"]);
  f.window.close();
});

test("spend view: search narrows the per-person table without touching the org stats", () => {
  const { f, calls, peopleRows } = render(DATA);
  const before = calls.shell.stats;
  assert.deepEqual(peopleRows(), ["bob", "alice", "carol"]);
  calls.shell.search.onInput("ali");
  assert.deepEqual(peopleRows(), ["alice"]);
  assert.equal(calls.shell.stats, before, "the shellbar is not rebuilt and the totals stay org-wide");
  calls.shell.search.onInput("");
  assert.deepEqual(peopleRows(), ["bob", "alice", "carol"]);
  f.window.close();
});

test("spend view: a Total header click sorts ascending, a second click descending, with no refetch", () => {
  const { f, calls, peopleRows } = render(DATA);
  const totalHeader = () =>
    [...f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll("thead th button")].find((b) =>
      b.textContent!.includes("Total"),
    ) as HTMLElement;
  totalHeader().click();
  assert.deepEqual(peopleRows(), ["carol", "alice", "bob"]);
  totalHeader().click();
  assert.deepEqual(peopleRows(), ["bob", "alice", "carol"]);
  assert.equal(calls.api, 0, "sorting is client-side");
  f.window.close();
});

test("spend view: a row click opens the sorted row's principal, and Export CSV downloads", () => {
  const { f, calls } = render(DATA);
  const rows = f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll<HTMLTableRowElement>("tbody tr");
  rows[1]!.click();
  assert.deepEqual(calls.opened, ["alice"], "the click indexes the sorted rows on screen");
  calls.shell.actions[0].click();
  assert.equal(calls.downloads, 1);
  f.window.close();
});

test("spend view: shared-scope rows are labelled and never open a user page", () => {
  const { f } = render(DATA);
  const shared = f.root.querySelectorAll(".tablewrap")[1]!;
  assert.equal(shared.querySelector("tbody td")!.textContent!.trim(), "#general");
  assert.equal(shared.querySelectorAll("tr.openable").length, 0);
  f.window.close();
});

test("spend view: an empty window renders empty-state copy and n/a, not a confident 0.0%", () => {
  const { f, calls } = render(EMPTY);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.stats[3])), ["n/a", "Cache hit rate"]);
  assert.equal(f.root.querySelectorAll(".tablewrap").length, 0);
  const text = f.root.textContent!;
  assert.ok(text.includes("No spend recorded in this window."), text);
  assert.ok(text.includes("No model calls recorded in this window."), text);
  f.window.close();
});

test("spend view: a null per-row cache ratio reads n/a", () => {
  const { f } = render({ ...DATA, people: [person("alice", 0, { cacheHitRatio: null })], scopes: [] });
  const cells = [...f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll("tbody td")].map((c) =>
    c.textContent!.trim(),
  );
  assert.equal(cells.at(-1), "n/a");
  f.window.close();
});

test("spend chart: category stacks and keyboard details use exact amounts", () => {
  const { f } = render({
    ...DATA,
    series: [{ day: "2026-09-24", live: { costUsd: 3 }, cron: { costUsd: 2 }, background: { costUsd: 1 } }],
  });
  const bar = f.root.querySelectorAll<HTMLElement>(".spend-column")[29]!;
  bar.dispatchEvent(new f.window.Event("focus"));
  assert.match(
    f.root.querySelector(".spend-chart-detail")!.textContent!,
    /Live \$3.00.*Crons \$2.00.*Background \$1.00/,
  );
  assert.equal(bar.querySelectorAll(".spend-segment").length, 3);
  assert.ok(!f.root.innerHTML.includes("NaN"));
  f.window.close();
});
test("spend chart: weekly bins preserve partial boundaries and zero spend is finite", () => {
  const { f } = render({
    ...DATA,
    window: { ...DATA.window, bucket: "week" },
    series: [{ day: "2026-08-24", live: { costUsd: 0 } }],
  });
  assert.equal(f.root.querySelectorAll(".spend-column").length, 5);
  assert.match(f.root.querySelector(".spend-column")!.getAttribute("aria-label")!, /Aug 26.*Aug 30/);
  assert.ok(!/NaN|Infinity/.test(f.root.innerHTML));
  f.window.close();
});

test("spend models: category breakdown, sorting, filtering and export", () => {
  const { f, calls } = render({
    ...DATA,
    models: [
      { ...person("", 10), model: "model-a", live: { costUsd: 3 }, cron: { costUsd: 6 }, background: { costUsd: 1 } },
      { ...person("", 6), model: null, live: { costUsd: 5 }, cron: { costUsd: 0 }, background: { costUsd: 1 } },
    ],
  });
  const names = () =>
    [...f.root.querySelectorAll(".spend-models tbody tr")].map((row) => row.querySelector("td")!.textContent!.trim());
  assert.deepEqual(names(), ["model-a", "Unknown model"]);
  const cells = [...f.root.querySelectorAll(".spend-models tbody tr:first-child td")].map((c) => c.textContent!.trim());
  assert.deepEqual(cells.slice(0, 5), ["model-a", "$10.00", "$3.00", "$6.00", "$1.00"]);
  const cron = [...f.root.querySelectorAll<HTMLElement>(".spend-models thead button")].find((b) =>
    b.textContent!.includes("Crons"),
  )!;
  cron.click();
  assert.deepEqual(names(), ["Unknown model", "model-a"]);
  calls.shell.search.onInput("model-a");
  assert.deepEqual(names(), ["model-a"]);
  calls.shell.search.onInput("unmatched");
  assert.match(f.root.querySelector(".spend-models")!.textContent!, /No models match/);
  [...f.root.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Export model CSV")!.click();
  assert.equal(calls.modelDownloads, 1);
  assert.equal(calls.downloads, 0);
  assert.deepEqual(calls.opened, []);
  f.window.close();
});

test("spend chart: model stacks use each bucket, retain gaps, and switch back to categories", () => {
  const data = {
    ...DATA,
    series: DATA.series.map((p, i) => ({
      ...p,
      models:
        i === 0
          ? [
              { model: "model-a", costUsd: 2 },
              { model: "model-b", costUsd: 4 },
            ]
          : [
              { model: "model-a", costUsd: 7 },
              { model: null, costUsd: 3 },
            ],
    })),
  };
  const { f, calls } = render(data);
  const bars = () => f.root.querySelectorAll<HTMLElement>(".spend-column");
  assert.match(f.root.querySelector(".spend-chart-plot")!.getAttribute("aria-label")!, /by model/);
  assert.match(bars()[28]!.getAttribute("aria-label")!, /model-a \$2.00.*model-b \$4.00.*Unknown model \$0.00/);
  assert.match(bars()[29]!.getAttribute("aria-label")!, /model-a \$7.00.*model-b \$0.00.*Unknown model \$3.00/);
  assert.deepEqual(
    [...bars()[29]!.querySelectorAll<HTMLElement>(".spend-segment")].map((s) => s.style.height),
    ["70%", "0%", "30%"],
  );
  assert.match(bars()[0]!.getAttribute("aria-label")!, /\$0.00 total/);
  bars()[29]!.dispatchEvent(new f.window.Event("focus"));
  assert.match(f.root.querySelector(".spend-chart-detail")!.textContent!, /model-a \$7.00/);
  calls.shell.search.onInput("alice");
  assert.match(f.root.querySelector(".spend-chart-plot")!.getAttribute("aria-label")!, /by model/);
  const toggle = (label: string) =>
    [...f.root.querySelectorAll<HTMLElement>(".spend-chart-switch button")].find(
      (b) => b.textContent!.trim() === label,
    )!;
  toggle("Category").click();
  assert.equal(toggle("Category").getAttribute("aria-pressed"), "true");
  assert.equal(bars()[29]!.querySelectorAll(".spend-live").length, 1);
  assert.match(bars()[29]!.getAttribute("aria-label")!, /Live \$10.00/);
  assert.doesNotMatch(f.root.querySelector(".spend-chart-detail")!.textContent!, /model-a/);
  toggle("Model").click();
  assert.equal(toggle("Model").getAttribute("aria-pressed"), "true");
  assert.equal(bars()[29]!.querySelectorAll(".spend-model").length, 3);
  assert.equal(calls.api, 0);
  f.window.close();
});

test("spend chart: weekly model stacks and zero totals remain finite", () => {
  const { f } = render({
    ...DATA,
    window: { ...DATA.window, bucket: "week" },
    series: [{ day: "2026-08-24", models: [{ model: null, costUsd: 0 }] }],
  });
  assert.equal(f.root.querySelectorAll(".spend-column").length, 5);
  assert.match(
    f.root.querySelector(".spend-column")!.getAttribute("aria-label")!,
    /Aug 26.*Aug 30.*Unknown model \$0.00/,
  );
  assert.ok(!/NaN|Infinity/.test(f.root.innerHTML));
  f.window.close();
});

for (const bucket of ["day", "week"]) {
  test(`spend chart: ${bucket} person toggle shows names, shared scopes and zero bins`, () => {
    const { f, calls, view } = render({
      ...DATA,
      window: { ...DATA.window, bucket },
      people: [person("alice", 3, { displayName: "Alice" }), person("bob", 2)],
      series: [
        {
          day: bucket === "day" ? "2026-09-24" : "2026-09-21",
          live: { costUsd: 10 },
          models: [{ model: "model-a", costUsd: 10 }],
          people: [
            { principalId: "alice", costUsd: 3 },
            { principalId: "bob", costUsd: 2 },
            { principalId: null, costUsd: 5 },
          ],
        },
      ],
    });
    const toggle = (label: string) =>
      [...f.root.querySelectorAll<HTMLButtonElement>(".spend-chart-switch button")].find(
        (b) => b.textContent!.trim() === label,
      )!;
    toggle("Person").click();
    assert.equal(toggle("Person").getAttribute("aria-pressed"), "true");
    const bars = () => f.root.querySelectorAll<HTMLElement>(".spend-column");
    assert.equal(bars().length, bucket === "day" ? 30 : 5);
    assert.match(
      bars()[0]!.getAttribute("aria-label")!,
      /\$0.00 total.*Alice \$0.00.*bob \$0.00.*Shared scopes \$0.00/,
    );
    const last = () => bars()[bars().length - 1]!;
    last().dispatchEvent(new f.window.Event("focus"));
    assert.match(
      f.root.querySelector(".spend-chart-detail")!.textContent!,
      /\$10.00 total.*Alice \$3.00.*bob \$2.00.*Shared scopes \$5.00/,
    );
    const colors = () => [...last().querySelectorAll<HTMLElement>(".spend-person")].map((s) => s.style.background);
    const before = colors();
    view.data.people[0].displayName = "Renamed Alice";
    calls.shell.search.onInput("unmatched");
    assert.deepEqual(colors(), before, "colors are stable across display-name changes and filtering");
    assert.deepEqual(
      [...last().querySelectorAll<HTMLElement>(".spend-segment")].map((s) => s.style.height),
      ["30%", "20%", "50%"],
    );
    for (const label of ["Category", "Model", "Person"]) {
      toggle(label).click();
      assert.equal(toggle(label).getAttribute("aria-pressed"), "true");
      assert.match(last().getAttribute("aria-label")!, /\$10.00 total/);
    }
    assert.ok(!/NaN|Infinity/.test(f.root.innerHTML));
    assert.equal(calls.api, 0);
    f.window.close();
  });
}

test("spend chart: person toggle is disabled for reports without person buckets", () => {
  const { f } = render(DATA);
  assert.equal(
    [...f.root.querySelectorAll<HTMLButtonElement>(".spend-chart-switch button")].find(
      (b) => b.textContent!.trim() === "Person",
    )!.disabled,
    true,
  );
  f.window.close();
});

function picker(f: ReturnType<typeof litFixture>) {
  const day = (label: string) => f.root.querySelector<HTMLButtonElement>(`.spend-range button[aria-label="${label}"]`);
  const nav = (label: string) => f.root.querySelector<HTMLButtonElement>(`.spend-range-nav[aria-label="${label}"]`)!;
  const months = () => [...f.root.querySelectorAll(".spend-range-title")].map((h) => h.textContent!.trim());
  const open = () => f.root.querySelector(".spend-range") !== null;
  return { day, nav, months, open };
}

test("spend view: the Custom tab opens a two-month UTC calendar and two picks apply an inclusive window", () => {
  const { f, calls } = render(DATA, { today: "2026-09-30" });
  const custom = calls.shell.tabs.at(-1);
  assert.deepEqual([custom.label, custom.active], ["Custom", false]);
  custom.onClick();
  const p = picker(f);
  assert.deepEqual(p.months(), ["August 2026", "September 2026"]);
  assert.equal(p.day("September 30, 2026")!.classList.contains("today"), true);
  p.day("September 1, 2026")!.click();
  assert.match(f.root.querySelector(".spend-range-hint")!.textContent!, /last day/);
  assert.equal(p.day("September 1, 2026")!.getAttribute("aria-pressed"), "true");
  assert.deepEqual(calls.customs, [], "the first pick waits for the second");
  p.day("September 30, 2026")!.click();
  assert.deepEqual(calls.customs, [["2026-09-01", "2026-10-01"]]);
  assert.equal(p.open(), false);
  assert.equal(calls.api, 0);
  f.window.close();
});

test("spend view: reversed picks swap, future days and months are disabled, and Escape or the backdrop dismisses", () => {
  const { f, calls } = render(DATA, { today: "2026-09-15" });
  const custom = calls.shell.tabs.at(-1);
  custom.onClick();
  const p = picker(f);
  assert.equal(p.day("September 15, 2026")!.disabled, false);
  assert.equal(p.day("September 16, 2026")!.disabled, true);
  assert.equal(p.nav("Next month").disabled, true);
  p.nav("Previous month").click();
  assert.deepEqual(p.months(), ["July 2026", "August 2026"]);
  assert.equal(p.nav("Next month").disabled, false);
  p.day("August 20, 2026")!.click();
  p.day("July 10, 2026")!.click();
  assert.deepEqual(calls.customs, [["2026-07-10", "2026-08-21"]]);
  custom.onClick();
  f.root.querySelector(".spend-range")!.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(p.open(), false);
  custom.onClick();
  f.root.querySelector<HTMLElement>(".spend-range-backdrop")!.click();
  assert.equal(p.open(), false);
  custom.onClick();
  p.day("September 3, 2026")!.click();
  p.day("September 3, 2026")!.click();
  assert.deepEqual(calls.customs.at(-1), ["2026-09-03", "2026-09-04"], "one day twice is a single-day window");
  f.window.close();
});

test("spend view: an applied custom window labels its tab, deactivates the presets and highlights its days", () => {
  const { f, calls } = render(DATA, { custom: { from: "2026-08-28", to: "2026-09-03" }, today: "2026-09-30" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shell.tabs.map((t: any) => [t.label, t.active]))), [
    ["7d", false],
    ["30d", false],
    ["90d", false],
    ["Aug 28 – Sep 2", true],
  ]);
  calls.shell.tabs[0].onClick();
  assert.deepEqual(calls.ranges, ["7d"]);
  calls.shell.tabs.at(-1).onClick();
  const p = picker(f);
  assert.deepEqual(p.months(), ["August 2026", "September 2026"]);
  const selected = [...f.root.querySelectorAll(".spend-range-day.in-range")].map((b) => b.getAttribute("aria-label"));
  assert.deepEqual(selected, [
    "August 28, 2026",
    "August 29, 2026",
    "August 30, 2026",
    "August 31, 2026",
    "September 1, 2026",
    "September 2, 2026",
  ]);
  const edges = [...f.root.querySelectorAll(".spend-range-day.edge")].map((b) => b.getAttribute("aria-label"));
  assert.deepEqual(edges, ["August 28, 2026", "September 2, 2026"]);
  f.window.close();
});

test("spend view: the custom tab label stays short, naming the year only when it is not the current one", () => {
  const label = (from: string, to: string, today = "2026-09-30") =>
    render(DATA, { custom: { from, to }, today }).calls.shell.tabs.at(-1).label;
  assert.equal(label("2026-09-01", "2026-10-01"), "Sep 1–30");
  assert.equal(label("2026-09-03", "2026-09-04"), "Sep 3");
  assert.equal(label("2026-08-28", "2026-09-03"), "Aug 28 – Sep 2");
  assert.equal(label("2025-03-01", "2025-04-01"), "Mar 1–31, 2025");
  assert.equal(label("2025-12-28", "2026-01-04"), "Dec 28, 2025 – Jan 3, 2026");
});
