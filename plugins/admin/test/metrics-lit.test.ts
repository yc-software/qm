import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

test("metric phase rows preserve percentile values and navigate to their detail", () => {
  const f = litFixture();
  let target: any;
  f.ui.metrics.metrics(
    f.root,
    { phases: [{ phase: "queue", p50: 10, p95: 20, p99: 30, count: 4 }] },
    {
      scope: "org:test",
      defaultShell() {},
      plural: String,
      phaseLabel: String,
      phaseDesc: () => "Queue delay",
      fmtMs: (n: number) => `${n}ms`,
      sparkline: () => f.document.createElement("span"),
      go: (value: any) => {
        target = value;
      },
    },
  );
  assert.deepEqual(
    [...f.root.querySelectorAll("th")].map((e) => e.textContent),
    ["Phase", "p50", "p95", "p99", "Turns", "Trend"],
  );
  assert.ok(f.root.textContent!.includes("10ms"));
  f.root.querySelector<HTMLTableRowElement>("tbody tr")!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(target)), {
    view: "metrics",
    scope: "org:test",
    session: null,
    phase: "queue",
  });
  f.window.close();
});

test("phase detail preserves distribution, daily values and scoped transcript links", () => {
  const f = litFixture();
  let target: any;
  f.ui.metrics.metrics(
    f.root,
    {
      phases: [
        {
          phase: "queue",
          p50: 10,
          p95: 20,
          p99: 30,
          count: 2,
          dist: [
            { le: 10, count: 2 },
            { le: 20, count: 0 },
          ],
          worst: [{ ms: 20, scopeLabel: "personal:alex", sessionId: "s1", turnSeq: 4 }],
        },
      ],
    },
    {
      phase: "queue",
      scope: "org:test",
      pageShell() {},
      phaseLabel: String,
      phaseDesc: String,
      fmtMs: String,
      shortName: String,
      turnKindWords: () => "",
      relTime: String,
      go: (value: any) => {
        target = value;
      },
    },
  );
  assert.equal(f.root.querySelectorAll(".dist-row").length, 1);
  assert.deepEqual(
    [...f.root.querySelectorAll("h2")].map((e) => e.textContent),
    ["Distribution", "By day", "Worst recent turns"],
  );
  f.root.querySelector<HTMLTableRowElement>("tr.openable")!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(target)), {
    view: "history",
    scope: "personal:alex",
    session: "s1",
    turn: 4,
  });
  f.window.close();
});
