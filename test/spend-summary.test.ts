import test from "node:test";
import assert from "node:assert/strict";
import { cacheHitRatio } from "../src/admin/metrics-sink.ts";
import type { SpendRow } from "../src/sessions/session-store.ts";
import { spendCsv, summarizeSpend, type SpendReport } from "../src/api/routes/admin/spend.ts";

const DAY = 86_400_000;
const MON = 20353;
const TUE = 20354;
const WED = 20355;

const row = (over: Partial<SpendRow> & Pick<SpendRow, "day" | "scopeId" | "origin">): SpendRow => ({
  model: null,
  calls: 1,
  costUsd: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...over,
});

const ROWS: SpendRow[] = [
  row({
    day: MON,
    scopeId: "personal:alice",
    origin: "conversation",
    costUsd: 1.5,
    input: 100,
    output: 10,
    cacheRead: 300,
    cacheWrite: 50,
  }),
  row({
    day: TUE,
    scopeId: "personal:alice",
    origin: "conversation",
    costUsd: 0.25,
    input: 20,
    output: 4,
    cacheRead: 60,
    cacheWrite: 0,
  }),
  row({
    day: TUE,
    scopeId: "personal:alice",
    origin: "cron",
    costUsd: 0.75,
    calls: 3,
    input: 40,
    output: 8,
    cacheRead: 120,
    cacheWrite: 10,
  }),
  row({
    day: TUE,
    scopeId: "personal:bob",
    origin: "conversation",
    costUsd: 0.5,
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  }),
  row({
    day: TUE,
    scopeId: "channel:C1",
    origin: "webhook",
    costUsd: 2,
    calls: 2,
    input: 5,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  }),
  row({
    day: WED,
    scopeId: "personal:bob",
    origin: "monitor",
    costUsd: 4,
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
  }),
];

const summarize = (rows: SpendRow[], over: Partial<Parameters<typeof summarizeSpend>[1]> = {}): SpendReport =>
  summarizeSpend(rows, {
    from: MON * DAY,
    to: (WED + 1) * DAY,
    bucket: "day",
    label: () => "",
    ...over,
  });

const conserved = (report: SpendReport, pick: (e: SpendReport["people"][number]) => number): number =>
  [...report.people, ...report.scopes].reduce((sum, e) => sum + pick(e), 0);

test("summarizeSpend: people plus non-person scopes conserve the org totals", () => {
  const report = summarize(ROWS);
  assert.deepEqual(
    report.people.map((p) => p.principalId),
    ["bob", "alice"],
    "people are ranked by total cost",
  );
  assert.deepEqual(
    report.people.map((p) => p.scopeId),
    ["personal:bob", "personal:alice"],
  );
  assert.deepEqual(
    report.scopes.map((s) => [s.principalId, s.scopeId, s.kind]),
    [[null, "channel:C1", "channel"]],
  );
  assert.ok(Math.abs(conserved(report, (e) => e.costUsd) - report.org.costUsd) <= 1e-9);
  for (const column of ["calls", "tokens", "input", "output", "cacheRead", "cacheWrite"] as const) {
    assert.equal(
      conserved(report, (e) => e[column]),
      report.org[column],
      column,
    );
  }
  const alice = report.people.find((p) => p.principalId === "alice")!;
  assert.equal(alice.live.costUsd, 1.75);
  assert.equal(alice.cron.costUsd, 0.75);
  assert.equal(alice.cron.calls, 3);
  assert.equal(alice.background.costUsd, 0);
  const bob = report.people.find((p) => p.principalId === "bob")!;
  assert.equal(bob.cron.costUsd, 0, "no cron rows means a zero cron bucket, not a missing one");
  assert.equal(bob.background.costUsd, 4, "monitor origin rolls up as background");
  assert.equal(report.scopes[0]!.background.costUsd, 2, "webhook origin rolls up as background");
});

test("summarizeSpend: cache hit ratio comes from the shared helper and is null without cache data", () => {
  const report = summarize(ROWS);
  assert.equal(
    report.org.cacheHitRatio,
    cacheHitRatio({
      cacheRead: report.org.cacheRead,
      cacheWrite: report.org.cacheWrite,
      uncachedInput: report.org.input,
    }),
  );
  for (const person of report.people) {
    assert.ok(person.cacheHitRatio === null || (person.cacheHitRatio >= 0 && person.cacheHitRatio <= 1));
  }
  const noCache = summarize([row({ day: MON, scopeId: "personal:zoe", origin: "conversation", costUsd: 0, input: 0 })]);
  assert.equal(noCache.people[0]!.cacheHitRatio, null, "a zero denominator reports null, never 0%");
});

test("summarizeSpend: zero-dollar calls keep their tokens instead of disappearing", () => {
  const report = summarize([
    row({
      day: MON,
      scopeId: "personal:codex",
      origin: "conversation",
      costUsd: 0,
      input: 900,
      output: 30,
      cacheRead: 70,
    }),
  ]);
  const codex = report.people[0]!;
  assert.equal(codex.costUsd, 0);
  assert.equal(codex.tokens, 1000);
  assert.ok(codex.cacheHitRatio !== null && codex.cacheHitRatio > 0);
});

test("summarizeSpend: the series is sparse, UTC-keyed, and restricted to [from, to)", () => {
  const report = summarize(ROWS);
  assert.deepEqual(
    report.series.map((p) => p.day),
    ["2025-09-22", "2025-09-23", "2025-09-24"],
  );
  for (const point of report.series) assert.match(point.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(report.series[0]!.costUsd, 1.5);
  assert.equal(report.series[2]!.background.costUsd, 4);
  assert.deepEqual(summarize([]).series, [], "an empty deployment gets no zero-filled calendar");

  const narrowed = summarizeSpend(
    ROWS.filter((r) => r.day >= TUE && r.day < WED),
    { from: TUE * DAY, to: WED * DAY, bucket: "day", label: () => "" },
  );
  assert.deepEqual(narrowed.window, { from: "2025-09-23", to: "2025-09-24", bucket: "day" });
  assert.deepEqual(
    narrowed.series.map((p) => p.day),
    ["2025-09-23"],
  );
  assert.ok(narrowed.org.costUsd < report.org.costUsd);
});

test("summarizeSpend: week buckets collapse to the Monday that starts them", () => {
  const report = summarize(ROWS, { bucket: "week" });
  assert.deepEqual(
    report.series.map((p) => p.day),
    ["2025-09-22"],
    "Wednesday 2025-09-24 belongs to the week starting Monday 2025-09-22",
  );
  const daily = summarize(ROWS);
  assert.ok(Math.abs(report.series[0]!.costUsd - daily.series.reduce((n, p) => n + p.costUsd, 0)) <= 1e-9);
  assert.equal(report.window.bucket, "week");
  assert.ok(Math.abs(conserved(report, (e) => e.costUsd) - report.org.costUsd) <= 1e-9);
});

test("spendCsv: one row per entity, people first, matching the report's numbers", () => {
  const report = summarize(ROWS);
  const lines = spendCsv(report).trimEnd().split("\r\n");
  assert.equal(
    lines[0],
    "principal_id,scope_id,kind,display_name,live_usd,cron_usd,background_usd,total_usd,calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_hit_ratio",
  );
  assert.equal(lines.length, report.people.length + report.scopes.length + 1);
  const bob = lines.find((l) => l.startsWith("bob,"))!.split(",");
  const bobRow = report.people.find((p) => p.principalId === "bob")!;
  assert.equal(Number(bob[7]), bobRow.costUsd);
  assert.equal(Number(bob[4]), bobRow.live.costUsd);
  assert.equal(Number(bob[6]), bobRow.background.costUsd);
  assert.equal(lines.at(-1)!.split(",")[1], "channel:C1", "non-person rows come last");
});

test("spendCsv: hostile display names are RFC 4180 quoted and de-fanged", () => {
  const labels = new Map([
    ["personal:alice", 'Alice "The, Closer"'],
    ["channel:C1", "=cmd|' /c calc'!A1"],
    ["personal:bob", "line one\r\nline two"],
  ]);
  const report = summarize(ROWS, { label: (id) => labels.get(id) ?? "" });
  const csv = spendCsv(report);
  assert.ok(csv.includes('"Alice ""The, Closer"""'), csv);
  assert.ok(csv.includes(`,'=cmd|' /c calc'!A1,`), csv);
  assert.ok(csv.includes('"line one\r\nline two"'), csv);
});

test("summarizeSpend: models conserve org totals and category totals across scopes and days", () => {
  const report = summarize(ROWS.map((r, i) => ({ ...r, model: ["alpha", "beta", null][i % 3]! })));
  assert.deepEqual(
    report.models.map((m) => m.model),
    [null, "beta", "alpha"],
  );
  for (const column of ["costUsd", "calls", "tokens", "input", "output", "cacheRead", "cacheWrite"] as const) {
    assert.equal(
      report.models.reduce((sum, m) => sum + m[column], 0),
      report.org[column],
      column,
    );
  }
  for (const origin of ["live", "cron", "background"] as const) {
    for (const column of ["costUsd", "calls", "tokens"] as const) {
      assert.equal(
        report.models.reduce((sum, m) => sum + m[origin][column], 0),
        report.org[origin][column],
      );
    }
  }
  for (const model of report.models) {
    assert.equal(
      model.cacheHitRatio,
      cacheHitRatio({
        cacheRead: model.cacheRead,
        cacheWrite: model.cacheWrite,
        uncachedInput: model.input,
      }),
    );
  }
  assert.equal(report.models.find((m) => m.model === null)!.cron.costUsd, 0.75);
  assert.deepEqual(summarize([]).models, []);
});

test("summarizeSpend: model ties sort by identifier with unknown last, independent of input order", () => {
  const rows = [null, "zeta", "alpha", ""].map((model) =>
    row({
      day: MON,
      scopeId: "personal:alice",
      origin: "conversation",
      model,
      costUsd: 1,
    }),
  );
  const report = summarize(rows);
  assert.deepEqual(
    report.models.map((m) => m.model),
    ["", "alpha", "zeta", null],
  );
  assert.deepEqual(summarize(rows.toReversed()).models, report.models);
});

test("spendCsv: model export retains totals, unknown models, and safe escaping", () => {
  const models = [null, 'Model "quoted", name', "line one\r\nline two", "=formula", "+formula", "-formula", "@formula"];
  const report = summarize(
    models.map((model) =>
      row({
        day: MON,
        scopeId: "personal:alice",
        origin: "cron",
        model,
        costUsd: 1,
        input: 100,
        cacheRead: 100,
      }),
    ),
  );
  const csv = spendCsv(report, "model");
  assert.ok(
    csv.startsWith(
      "model,live_usd,cron_usd,background_usd,total_usd,calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_hit_ratio\r\n",
    ),
  );
  assert.ok(csv.includes('"Model ""quoted"", name",0,1,0,1,1,100,0,100,0,0.5\r\n'));
  assert.ok(csv.includes('"line one\r\nline two"'));
  for (const model of ["=formula", "+formula", "-formula", "@formula"]) assert.ok(csv.includes(`'${model},`));
  assert.ok(csv.includes("Unknown model,0,1,0,1,1,100,0,100,0,0.5\r\n"));
  assert.equal(spendCsv(report), spendCsv(report, "entity"));
});

for (const bucket of ["day", "week"] as const) {
  test(`summarizeSpend: ${bucket} model series conserves each point and window model totals`, () => {
    const rows = [
      row({ day: MON, scopeId: "personal:alice", origin: "conversation", model: "alpha", costUsd: 1 }),
      row({ day: MON, scopeId: "personal:alice", origin: "cron", model: "alpha", costUsd: 2 }),
      row({ day: MON, scopeId: "channel:C1", origin: "webhook", model: "beta", costUsd: 4 }),
      row({ day: MON, scopeId: "personal:bob", origin: "monitor", model: null, costUsd: 8 }),
      row({ day: TUE, scopeId: "personal:alice", origin: "conversation", model: "alpha", costUsd: 16 }),
      row({ day: MON + 6, scopeId: "personal:bob", origin: "cron", model: null, costUsd: 32 }),
      row({ day: MON + 7, scopeId: "personal:bob", origin: "conversation", model: "beta", costUsd: 64 }),
      row({ day: MON + 7, scopeId: "personal:bob", origin: "conversation", model: "free", costUsd: 0 }),
    ];
    const report = summarize(rows, { bucket, to: (MON + 8) * DAY });
    assert.deepEqual(
      report.series[0]!.models,
      bucket === "day"
        ? [
            { model: null, costUsd: 8 },
            { model: "beta", costUsd: 4 },
            { model: "alpha", costUsd: 3 },
          ]
        : [
            { model: null, costUsd: 40 },
            { model: "alpha", costUsd: 19 },
            { model: "beta", costUsd: 4 },
          ],
    );
    assert.deepEqual(report.series.at(-1)!.models, [
      { model: "beta", costUsd: 64 },
      { model: "free", costUsd: 0 },
    ]);
    assert.equal(report.series.at(-1)!.day, "2025-09-29");
    const modelTotals = new Map<string | null, number>();
    for (const point of report.series) {
      assert.equal(
        point.models.reduce((sum, m) => sum + m.costUsd, 0),
        point.costUsd,
      );
      for (const model of point.models) {
        modelTotals.set(model.model, (modelTotals.get(model.model) ?? 0) + model.costUsd);
      }
    }
    assert.equal(modelTotals.size, report.models.length);
    for (const model of report.models) assert.equal(modelTotals.get(model.model), model.costUsd);
    assert.deepEqual(summarize(rows.toReversed(), { bucket, to: (MON + 8) * DAY }).series, report.series);
  });
}
