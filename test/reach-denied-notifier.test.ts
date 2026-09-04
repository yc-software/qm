import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog, type AuditEvent } from "../src/audit/audit-log.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createReachDeniedNotifier, type ReachDeniedCursor } from "../src/insights/reach-denied-notifier.ts";
import { scopeId } from "../src/types.ts";

const denial = (at: number, who: string, app: string): AuditEvent => ({
  at,
  principalId: who,
  action: "deployment.reach_denied",
  resource: app,
  scopeLabel: scopeId("personal", "owner@x.com"),
  status: "denied",
});

function fixture(nowMs: number) {
  const auditLog = createAuditLog();
  const cursors = createMemoryMap<ReachDeniedCursor>();
  const sent: AuditEvent[] = [];
  const notifier = createReachDeniedNotifier({
    auditLog,
    cursors,
    notify: async (e) => {
      sent.push(e);
    },
    now: () => nowMs,
  });
  return { auditLog, cursors, sent, notifier };
}

test("reach-denied notifier: forwards only rows newer than the watermark, oldest first, and advances it", async () => {
  const t0 = 1_000_000;
  const { auditLog, sent, notifier } = fixture(t0);
  auditLog.record({ ...denial(t0 - 5, "old@x.com", "before-start"), action: "deployment.reach_denied" });
  auditLog.record({
    at: t0 + 1,
    principalId: "a",
    action: "deploy_share",
    resource: "x",
    scopeLabel: scopeId("org", "acme"),
  });

  notifier.start(1_000_000_000);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, [], "rows from before the notifier started are not replayed; other actions are ignored");

  auditLog.record(denial(t0 + 10, "dana@example.com", "invoice-tracker"));
  auditLog.record(denial(t0 + 5, "evan@example.com", "status-board"));
  notifier.stop();

  const { auditLog: log2, cursors, sent: sent2, notifier: n2 } = fixture(t0);
  log2.record(denial(t0 + 10, "dana@example.com", "invoice-tracker"));
  log2.record(denial(t0 + 5, "evan@example.com", "status-board"));
  await cursors.put("reach-denied-notify", { lastAt: t0 });
  n2.start(1_000_000_000);
  await new Promise((r) => setTimeout(r, 10));
  n2.stop();
  assert.deepEqual(
    sent2.map((e) => [e.principalId, e.resource]),
    [
      ["evan@example.com", "status-board"],
      ["dana@example.com", "invoice-tracker"],
    ],
    "both fresh rows forwarded, oldest first",
  );
  assert.deepEqual(await cursors.get("reach-denied-notify"), { lastAt: t0 + 10 }, "watermark advanced");
});

test("reach-denied notifier: a failing notify leaves the watermark so the row retries", async () => {
  const t0 = 2_000_000;
  const auditLog = createAuditLog();
  const cursors = createMemoryMap<ReachDeniedCursor>();
  await cursors.put("reach-denied-notify", { lastAt: t0 });
  let fail = true;
  const sent: string[] = [];
  const notifier = createReachDeniedNotifier({
    auditLog,
    cursors,
    notify: async (e) => {
      if (fail) throw new Error("outbox down");
      sent.push(e.resource);
    },
    now: () => t0,
  });
  auditLog.record(denial(t0 + 1, "u@x.com", "contracts"));
  notifier.start(1_000_000_000);
  await new Promise((r) => setTimeout(r, 10));
  notifier.stop();
  assert.equal(sent.length, 0);
  assert.deepEqual(await cursors.get("reach-denied-notify"), { lastAt: t0 }, "watermark untouched on failure");

  fail = false;
  const n2 = createReachDeniedNotifier({
    auditLog,
    cursors,
    notify: async (e) => {
      sent.push(e.resource);
    },
    now: () => t0,
  });
  n2.start(1_000_000_000);
  await new Promise((r) => setTimeout(r, 10));
  n2.stop();
  assert.deepEqual(sent, ["contracts"], "the row is delivered on the next tick");
});
