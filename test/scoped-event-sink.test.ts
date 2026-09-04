import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createScopedEventSink } from "../src/admin/scoped-event-sink.ts";
import { createErrorLog } from "../src/admin/error-log.ts";
import { createMetricsSink } from "../src/admin/metrics-sink.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

const s1 = scopeId("personal", "u1");
const s2 = scopeId("personal", "u2");

test("scoped sink stamps, bounds (ring buffer), and lists newest-first", () => {
  const sink = createScopedEventSink<
    { ts: number; n: number; scopeLabel: typeof s1 },
    { n: number; scopeLabel: typeof s1 }
  >({
    max: 3,
    defaultLimit: 10,
    stamp: (i) => ({ ...i, ts: i.n }),
  });
  for (const n of [1, 2, 3, 4, 5]) sink.record({ n, scopeLabel: s1 });
  assert.equal(sink.all().length, 3, "ring buffer caps at max");
  assert.deepEqual(
    sink.list().map((e) => e.n),
    [5, 4, 3],
    "newest-first, oldest dropped",
  );
});

test("scoped sink filters by scope and applies an extra predicate + limit", () => {
  const sink = createScopedEventSink<{ ts: number; scopeLabel: typeof s1 }, { ts: number; scopeLabel: typeof s1 }>({
    max: 100,
    defaultLimit: 100,
    stamp: (i) => i,
  });
  sink.record({ ts: 1, scopeLabel: s1 });
  sink.record({ ts: 2, scopeLabel: s2 });
  sink.record({ ts: 3, scopeLabel: s1 });
  assert.deepEqual(
    sink.list({ scopeId: s1 }).map((e) => e.ts),
    [3, 1],
  );
  assert.deepEqual(
    sink.list({ filter: (e) => e.ts >= 2 }).map((e) => e.ts),
    [3, 2],
  );
  assert.deepEqual(
    sink.list({ scopeId: s1, limit: 1 }).map((e) => e.ts),
    [3],
  );
});

test("error log records and lists scope-filtered newest-first", async () => {
  const log = createErrorLog();
  log.record({ category: "turn", code: "error", message: "shape-only", scopeLabel: s1 });
  log.record({ category: "egress", code: "denied", message: "shape-only", scopeLabel: s2 });
  const mine = await log.list({ scopeId: s1 });
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.category, "turn");
  assert.ok(typeof mine[0]?.ts === "number");
  assert.equal(await log.count(), 2, "count totals every event");
  assert.equal(await log.count({ scopeId: s1 }), 1, "count honors the scope filter");
});

test("metrics sink honors the since cutoff via the shared sink", async () => {
  const sink = createMetricsSink();
  sink.record({ totalMs: 10, status: "ok", scopeLabel: s1 });
  const cutoff = Date.now() + 1;
  assert.equal((await sink.list({ since: cutoff })).length, 0, "nothing at/after a future cutoff");
  assert.equal((await sink.list()).length, 1);
});

test("audit log is now bounded (latent leak fixed) and preserves insertion order", async () => {
  const log = createAuditLog();
  for (let i = 0; i < 50001; i++) {
    log.record({ at: i, principalId: "p", action: "turn", resource: "r", scopeLabel: s1 });
  }
  const events = await log.events();
  assert.equal(events.length, 50000, "bounded at the cap");
  assert.equal(events[0]?.at, 1, "oldest event dropped");
  assert.equal(events[events.length - 1]?.at, 50000, "newest retained, oldest-first order");
});
