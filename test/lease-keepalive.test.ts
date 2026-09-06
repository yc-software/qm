import { test } from "node:test";
import assert from "node:assert/strict";
import { startLeaseKeepalive } from "../src/core/orchestrator/lease-keepalive.ts";
import { wallClockTurnFailure } from "../src/harness/pi-harness.ts";
import type { Lease } from "../src/sessions/session-store.ts";

const lease: Lease = { sessionId: "s1", token: "t1" };

function until(cond: () => boolean, ms = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("condition never held"));
      }
    }, 5);
  });
}

test("a transient renew failure does not kill the keepalive", async () => {
  let calls = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return true;
      },
    },
    lease,
    10,
    () => false,
  );
  await until(() => calls >= 3);
  stop();
});

test("a genuinely lost lease stops the keepalive", async () => {
  let calls = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        calls += 1;
        return false;
      },
    },
    lease,
    10,
    () => false,
  );
  await until(() => calls === 1);
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, after, "no further renewals after the lease is lost");
  stop();
});

test("a turn making no progress trips the liveness bound and aborts instead of renewing forever", async () => {
  let renewals = 0;
  let stalled = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        renewals += 1;
        return true;
      },
    },
    lease,
    5,
    () => false,
    { progress: () => 0, stalledRenewals: 3, onStalled: () => stalled++ },
  );
  await until(() => stalled === 1);
  const after = renewals;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(renewals, after, "renewal stops once the stall bound trips");
  assert.equal(stalled, 1, "the abort fires exactly once");
  assert.ok(renewals < 3, "the stalled interval aborts before renewing again");
  stop();
});

test("turn progress resets the stall counter and keeps the lease renewing", async () => {
  let renewals = 0;
  let stalled = 0;
  let progress = 0;
  const stop = startLeaseKeepalive(
    {
      renewLease: async () => {
        renewals += 1;
        return true;
      },
    },
    lease,
    5,
    () => false,
    { progress: () => progress, stalledRenewals: 3, onStalled: () => stalled++ },
  );
  const feeder = setInterval(() => progress++, 5);
  await until(() => renewals >= 10);
  clearInterval(feeder);
  assert.equal(stalled, 0, "a progressing turn is never aborted");
  stop();
});

test("wall-clock failure survives a cancel only for abandoned turns", () => {
  assert.equal(wallClockTurnFailure("ok", false, false), false);
  assert.equal(wallClockTurnFailure("ok", false, true), false);
  assert.equal(wallClockTurnFailure("aborted", false, false), true);
  assert.equal(wallClockTurnFailure("aborted", true, false), false);
  assert.equal(wallClockTurnFailure("aborted", false, true), false);
  assert.equal(wallClockTurnFailure("abandoned", false, true), true);
  assert.equal(wallClockTurnFailure("abandoned", false, false), true);
});
