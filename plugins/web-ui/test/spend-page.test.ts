import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";

let requests: Array<{ path: string; resolve: (response: Response) => void }> = [];
const { vite, close } = await browserEnv({
  dom: { url: "http://localhost/spend" },
  fetch: (input) => {
    const path = String(input);
    if (path === "/api/contexts")
      return Promise.resolve(
        Response.json({
          contexts: [{ scopeId: "channel:C1", kind: "channel", name: "general", sessionCount: 1, lastActivityAt: 1 }],
        }),
      );
    return new Promise<Response>((resolve) => requests.push({ path, resolve }));
  },
});
after(close);

let appState: { currentView: string; mainEl: HTMLElement | null; me: { user: string; org: string } | null };
let renderSpend: () => Promise<void>;
let resetSpendState: () => void;
let main: HTMLElement;

beforeEach(async () => {
  requests = [];
  document.body.innerHTML = '<div id="app"></div><main></main>';
  main = document.querySelector("main")!;
  vite.moduleGraph.invalidateAll();
  ({ appState } = await vite.ssrLoadModule("/src/shell.ts"));
  ({ renderSpend, resetSpendState } = await vite.ssrLoadModule("/src/spend.ts"));
  resetSpendState();
  appState.currentView = "spend";
  appState.mainEl = main;
  appState.me = { user: "alice", org: "test" };
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const totals = (costUsd: number, over: Record<string, unknown> = {}) => ({
  costUsd,
  calls: 2,
  tokens: 1_500,
  cacheHitRatio: 0.5,
  live: { costUsd },
  background: { costUsd: 0, sources: {} },
  ...over,
});
const report = (window: Record<string, string>, over: Record<string, unknown> = {}) => ({
  window,
  org: totals(5.5),
  series: [],
  people: [{ principalId: "alice", scopeId: "personal:alice", kind: "person", displayName: "", ...totals(2.5) }],
  scopes: [{ principalId: null, scopeId: "channel:C1", kind: "channel", displayName: "general", ...totals(3) }],
  crons: [
    {
      cronId: "mine",
      scopeId: "personal:alice",
      scopeName: "",
      owned: true,
      info: {
        id: "mine",
        title: "Morning digest",
        owner: "alice",
        ownerScopeId: "personal:alice",
        schedule: { cron: "0 9 * * *" },
      },
      ...totals(0.5),
    },
    {
      cronId: "theirs",
      scopeId: "channel:C1",
      scopeName: "general",
      owned: false,
      info: {
        id: "theirs",
        title: "Standup notes",
        owner: "bob.smith@example.com",
        ownerScopeId: "channel:C1",
        schedule: { everyMs: 86_400_000 },
      },
      ...totals(1),
    },
    { cronId: "gone", scopeId: "personal:alice", scopeName: "", owned: false, info: null, ...totals(0.25) },
  ],
  models: [{ model: "model-a", ...totals(5.5) }],
  ...over,
});
const pending = (prefix = "/api/spend?") => {
  const found = requests.find((r) => r.path.startsWith(prefix));
  assert.ok(found, `requested ${prefix}`);
  requests = requests.filter((r) => r !== found);
  return { ...found, query: Object.fromEntries(new URL(found.path, "http://web").searchParams) };
};
const text = (selector: string) =>
  [...main.querySelectorAll(selector)].map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "");
const panel = (title: string) =>
  [...main.querySelectorAll<HTMLElement>(".context-panel")].find(
    (el) => el.querySelector(".context-panel-title")?.textContent === title,
  )!;
const squash = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const panelRows = (title: string) =>
  [...panel(title).querySelectorAll(".spend-row")].map((el) => {
    const meta = el.querySelector(".context-session-meta")!.cloneNode(true) as HTMLElement;
    meta.querySelector(".spend-amount")?.remove();
    return [
      squash(el.querySelector(".context-session-title")),
      squash(meta),
      squash(el.querySelector(".spend-amount")),
    ];
  });
const chip = (label: string) =>
  [...main.querySelectorAll<HTMLButtonElement>(".cron-filter-chip")].find((b) => b.textContent?.trim() === label)!;

test("shows your spend, your shared spaces, your crons apart from others', and models", async () => {
  const rendering = renderSpend();
  await settle();
  assert.deepEqual(text(".spend-content > .status"), ["Loading…"]);
  const first = pending();
  assert.equal(first.query.bucket, "day");
  first.resolve(Response.json(report({ from: first.query.from!, to: first.query.to!, bucket: "day" })));
  await rendering;

  assert.deepEqual(text(".spend-stats strong"), ["$2.50", "$3.00"]);
  assert.deepEqual(panelRows("By shared space"), [["#general", "Live $3.00", "$3.00"]]);
  assert.deepEqual(panelRows("Your crons"), [["Morning digest", "cron 0 9 * * * Open", "$0.50"]]);
  assert.deepEqual(panelRows("Crons others made"), [["Standup notes", "Bob Smith general every 1d Open", "$1.00"]]);
  assert.deepEqual(panelRows("By model"), [["model-a", "2 calls · 1.5K tokens · 50% cache hit", "$5.50"]]);
  assert.deepEqual(panelRows("Deleted or private crons"), [["Cron gone", "", "$0.25"]]);
  assert.equal(
    panel("Your crons").querySelector<HTMLAnchorElement>("a.context-resource-link")?.getAttribute("href"),
    "/crons/mine",
  );
});

test("a slower earlier window never paints over the window chosen after it", async () => {
  const rendering = renderSpend();
  await settle();
  const thirty = pending();
  chip("7d").click();
  await settle();
  const seven = pending();
  assert.notEqual(seven.query.from, thirty.query.from);
  const yours = (costUsd: number) => [{ principalId: "alice", scopeId: "personal:alice", ...totals(costUsd) }];
  seven.resolve(
    Response.json(report({ from: seven.query.from!, to: seven.query.to!, bucket: "day" }, { people: yours(7) })),
  );
  await settle();
  thirty.resolve(
    Response.json(report({ from: thirty.query.from!, to: thirty.query.to!, bucket: "day" }, { people: yours(30) })),
  );
  await rendering;
  await settle();
  assert.equal(text(".spend-stats strong")[0], "$7.00");
  assert.ok(
    panel("Spend over time").querySelector(".context-panel-copy")!.textContent!.startsWith(`${seven.query.from} to`),
  );
  assert.equal(chip("7d").getAttribute("aria-selected"), "true");
});

test("returning to the shown window drops the load that was still pending", async () => {
  const yours = (costUsd: number) => [{ principalId: "alice", scopeId: "personal:alice", ...totals(costUsd) }];
  const rendering = renderSpend();
  await settle();
  const thirty = pending();
  thirty.resolve(
    Response.json(report({ from: thirty.query.from!, to: thirty.query.to!, bucket: "day" }, { people: yours(30) })),
  );
  await rendering;
  chip("7d").click();
  await settle();
  const seven = pending();
  chip("30d").click();
  await settle();
  assert.equal(requests.length, 0, "the 30d report on screen is reused");
  seven.resolve(
    Response.json(report({ from: seven.query.from!, to: seven.query.to!, bucket: "day" }, { people: yours(7) })),
  );
  await settle();
  await settle();
  assert.equal(text(".spend-stats strong")[0], "$30.00");
  assert.equal(chip("30d").getAttribute("aria-selected"), "true");
  assert.equal(text(".spend-content > .status").includes("Loading…"), false);
});

test("switching windows keeps keyboard focus on the chosen chip", async () => {
  const rendering = renderSpend();
  await settle();
  const first = pending();
  first.resolve(Response.json(report({ from: first.query.from!, to: first.query.to!, bucket: "day" })));
  await rendering;
  chip("7d").focus();
  chip("7d").click();
  await settle();
  assert.equal(document.activeElement, chip("7d"));
});

test("Custom edits the shown window and applies two UTC days as a half-open window", async () => {
  const rendering = renderSpend();
  await settle();
  const first = pending();
  first.resolve(Response.json(report({ from: first.query.from!, to: first.query.to!, bucket: "day" })));
  await rendering;
  chip("Custom").click();
  await settle();
  assert.equal(requests.length, 0, "choosing Custom keeps the shown window without asking again");
  const [start, end] = [...main.querySelectorAll<HTMLInputElement>(".spend-custom input")];
  start!.value = "2026-09-01";
  end!.value = "2026-09-10";
  main.querySelector<HTMLButtonElement>(".spend-custom button")!.click();
  await settle();
  const custom = pending();
  assert.deepEqual(custom.query, { from: "2026-09-01", to: "2026-09-11", bucket: "day" });
});

test("a failed load drops the previous window's numbers, and the next good load clears the error", async () => {
  const rendering = renderSpend();
  await settle();
  const first = pending();
  first.resolve(Response.json(report({ from: first.query.from!, to: first.query.to!, bucket: "day" })));
  await rendering;
  chip("7d").click();
  await settle();
  pending().resolve(Response.json({ error: "spend_unavailable" }, { status: 503 }));
  await settle();
  await settle();
  assert.deepEqual(text(".spend-content > .status"), ["spend_unavailable"]);
  assert.equal(main.querySelector(".spend-stats"), null, "no 30d numbers under the 7d tab");
  chip("30d").click();
  await settle();
  const again = pending();
  again.resolve(Response.json(report({ from: again.query.from!, to: again.query.to!, bucket: "day" })));
  await settle();
  await settle();
  assert.equal(text(".spend-content > .status").filter((t) => t === "spend_unavailable").length, 0);
  assert.deepEqual(text(".spend-stats strong"), ["$2.50", "$3.00"]);
});
