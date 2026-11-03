import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

const totals = (costUsd: number, over: Record<string, unknown> = {}) => ({
  costUsd,
  calls: 2,
  tokens: 1_500,
  cacheHitRatio: 0.5,
  live: { costUsd },
  background: { costUsd: 0, sources: {} },
  ...over,
});

const REPORT = {
  window: { from: "2026-09-01", to: "2026-09-04", bucket: "day" },
  org: totals(5.75),
  series: [{ day: "2026-09-02", live: { costUsd: 4 }, background: { sources: { cron: { costUsd: 1.75 } } } }],
  people: [{ principalId: "alice", scopeId: "personal:alice", displayName: "", ...totals(2.5) }],
  scopes: [
    { principalId: null, scopeId: "channel:C1", displayName: "general", ...totals(3) },
    { principalId: null, scopeId: "group:G1", displayName: "", ...totals(0) },
  ],
  crons: [
    {
      cronId: "mine",
      scopeId: "personal:alice",
      scopeName: "",
      owned: true,
      info: { id: "mine", title: "Morning digest", owner: "alice", schedule: { cron: "0 9 * * *" } },
      ...totals(0.5),
    },
    {
      cronId: "theirs",
      scopeId: "channel:C1",
      scopeName: "general",
      owned: false,
      info: { id: "theirs", title: "Standup notes", owner: "bob.smith@example.com", schedule: { everyMs: 86_400_000 } },
      ...totals(1),
    },
    { cronId: "gone1234abcd", scopeId: "personal:alice", scopeName: "", owned: false, info: null, ...totals(0.25) },
  ],
  models: [{ model: "model-a", ...totals(5.75) }],
};

const rows = (doc: Document, title: string) => {
  const card = [...doc.querySelectorAll(".card")].find((el) => el.querySelector("h2")?.textContent === title)!;
  assert.ok(card, `card ${title}`);
  return [...card.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent!.replace(/\s+/g, " ").trim()),
  );
};

test("my spend: asks for the window, charts it, and splits spaces, crons and models", async () => {
  const page = await mountPage("/settings/my-spend?from=2026-09-01&to=2026-09-04", {
    "GET /api/spend": REPORT,
    "GET /api/contexts": { contexts: [{ scopeId: "channel:C1", kind: "channel", name: "general" }] },
  });
  await page.settle();
  const spend = page.requests.find((r) => r.path === "/api/spend")!;
  assert.equal(spend.url.search, "?from=2026-09-01&to=2026-09-04&bucket=day");
  assert.equal(page.document.querySelectorAll(".spend-column").length, 3);
  const doc = page.document;
  assert.match(
    [...doc.querySelectorAll(".card .head p")][0]!.textContent!,
    /^2026-09-01 to 2026-09-03 \(UTC, daily\) · Yours \$2\.50 · Shared spaces \$3\.00$/,
  );
  assert.deepEqual(rows(doc, "By shared space"), [
    ["#general", "Live $3.00", "$3.00"],
    ["Group DM", "Live $0.00", "$0.00"],
  ]);
  assert.deepEqual(rows(doc, "Your crons"), [["Morning digest", "Personal", "cron 0 9 * * *", "$0.50"]]);
  assert.deepEqual(rows(doc, "Crons others made"), [["Standup notes", "Bob Smith", "#general", "every 1d", "$1.00"]]);
  assert.deepEqual(rows(doc, "Deleted or private crons"), [["Cron gone1234", "Personal", "$0.25"]]);
  assert.deepEqual(rows(doc, "By model"), [["model-a", "2", "1,500", "50.0%", "$5.75"]]);
  const hrefs = [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("/crons/mine"));
  assert.ok(hrefs.includes("/settings/my-spend?range=7d"));
  page.close();
});

test("my spend: custom windows stay within the 93 days core serves", async () => {
  const page = await mountPage("/settings/my-spend?from=2026-01-01&to=2026-09-04", {
    "GET /api/spend": REPORT,
    "GET /api/contexts": { contexts: [] },
  });
  await page.settle();
  const spend = page.requests.find((r) => r.path === "/api/spend")!;
  assert.equal(spend.url.searchParams.get("from"), "2026-06-03");
  assert.equal(spend.url.searchParams.get("bucket"), "week");
  assert.match(page.document.querySelector(".spend-custom .hint")!.textContent!, /up to 93 days/);
  page.close();
});

test("my spend: a failed load says so instead of showing numbers", async () => {
  const page = await mountPage("/settings/my-spend", {
    "GET /api/spend": { status: 503, body: { error: "spend_unavailable" } },
    "GET /api/contexts": { contexts: [] },
  });
  await page.settle();
  assert.equal(page.document.querySelector(".card"), null);
  assert.match(page.document.querySelector(".empty")!.textContent!, /spend_unavailable/);
  page.close();
});
