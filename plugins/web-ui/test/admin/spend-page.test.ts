import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

const DATA = {
  window: { from: "2026-09-01", to: "2026-09-04", bucket: "day" },
  org: { costUsd: 6, calls: 3 },
  series: [{ day: "2026-09-02", live: { costUsd: 4 }, background: { sources: { cron: { costUsd: 2 } } } }],
  people: [{ principalId: "alex@example.com", costUsd: 4, live: { costUsd: 4 }, tokens: 10, cacheHitRatio: null }],
  scopes: [],
  crons: [{ cronId: "cr1", scopeId: "personal:alex@example.com", costUsd: 2, info: { title: "Digest" } }],
  models: [],
};

test("spend: custom window query, chart, rows linking to user and cron runs, and custom range apply", async () => {
  const page = await mountPage("/settings/spend?from=2026-09-01&to=2026-09-04", { "GET /spend": DATA });
  await page.settle();
  const query = page.requests.find((r) => r.path === "/spend")!.url.search;
  assert.equal(query, "?from=2026-09-01&to=2026-09-04&bucket=day");
  assert.equal(page.document.querySelectorAll(".spend-column").length, 3);
  const hrefs = [...page.document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("/settings/user?principal=alex%40example.com"));
  assert.ok(hrefs.includes("/settings/history?scope=personal%3Aalex%40example.com&kind=cron&cron=cr1"));
  assert.ok(hrefs.includes("/settings/spend?range=7d"));
  const [first, last] = page.document.querySelectorAll<HTMLInputElement>(".spend-custom input");
  first!.value = "2026-09-10";
  last!.value = "2026-09-05";
  page.document.querySelector(".spend-custom")!.dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await page.settle();
  assert.equal(page.location(), "/settings/spend?from=2026-09-05&to=2026-09-11");
  page.close();
});
