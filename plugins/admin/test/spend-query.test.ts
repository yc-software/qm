import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function spendHelpers() {
  const grab = (name: string): string => {
    const source = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {6}\\}`))?.[0];
    assert.ok(source, `${name} helper exists`);
    return source!;
  };
  const ranges = html.match(/const SPEND_RANGES = \{[^}]*\};/)?.[0];
  assert.ok(ranges, "SPEND_RANGES exists");
  return new Function(`${ranges}
    ${grab("customSpendWindow")};
    ${grab("spendQuery")};
    return { customSpendWindow, spendQuery };`)() as {
    customSpendWindow: (st: Record<string, unknown>) => { from: string; to: string } | null;
    spendQuery: (st: Record<string, unknown>) => string;
  };
}

const query = (st: Record<string, unknown>) => Object.fromEntries(new URLSearchParams(spendHelpers().spendQuery(st)));

test("spend query: a custom window is sent as-is, in daily buckets up to 62 days and weekly beyond", () => {
  assert.deepEqual(query({ from: "2026-09-01", to: "2026-10-01" }), {
    from: "2026-09-01",
    to: "2026-10-01",
    bucket: "day",
  });
  assert.deepEqual(query({ range: "7d", from: "2026-07-01", to: "2026-09-01" }), {
    from: "2026-07-01",
    to: "2026-09-01",
    bucket: "day",
  });
  assert.equal(query({ from: "2026-06-30", to: "2026-09-01" }).bucket, "week");
});

test("spend query: malformed, impossible, empty or reversed custom windows fall back to the preset", () => {
  const { customSpendWindow } = spendHelpers();
  for (const [from, to] of [
    ["2026-09-01", "2026-09-01"],
    ["2026-10-01", "2026-09-01"],
    ["2026-02-30", "2026-03-02"],
    ["2026-9-1", "2026-10-01"],
    ["2026-09-01", null],
  ]) {
    assert.equal(customSpendWindow({ from, to }), null, `${from} to ${to}`);
    const preset = query({ range: "7d", from, to });
    assert.equal(preset.bucket, "day");
    assert.equal((Date.parse(preset.to!) - Date.parse(preset.from!)) / 86400000, 7);
  }
});
