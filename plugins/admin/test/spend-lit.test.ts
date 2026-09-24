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

function render(data: any) {
  const f = litFixture();
  const calls: any = { shell: null, ranges: [], opened: [], downloads: 0, api: 0 };
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
    sparkline: (rows: any[], valueOf: (r: any) => number) => {
      const span = f.document.createElement("span");
      span.textContent = rows.map(valueOf).join("/");
      return span;
    },
    openUser: (principal: string) => calls.opened.push(principal),
    setRange: (range: string) => calls.ranges.push(range),
    downloadCsv: () => {
      calls.downloads += 1;
    },
  });
  const peopleRows = () =>
    [...f.root.querySelectorAll(".tablewrap")[0]!.querySelectorAll("tbody tr")].map((r) =>
      r.querySelector("td")!.textContent!.trim(),
    );
  return { f, calls, view, peopleRows };
}

test("spend view: KPI stats, sparkline and range tabs describe the whole org", () => {
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
  ]);
  assert.ok(f.root.textContent!.includes("6/10"), "the sparkline reads the spend series, not p50");
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
