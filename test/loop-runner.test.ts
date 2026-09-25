import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { buildShipGrant } from "../src/loops/ship-gate.ts";
import { fireNeedsAttention, runLoopFire, type LoopRunnerEffects, type LoopStores } from "../src/loops/runner.ts";
import { scopeId, type Loop } from "../src/types.ts";

const base = {
  owner: "U1",
  createdBy: "U1",
  ownerScopeId: scopeId("personal", "U1"),
  name: "Sentry triage",
  playbook: "fix the issue",
  successCondition: "a PR is linked and CI is green",
  shipActions: [{ action: "open_pr", gate: "hold" as const }],
};

function stores(): LoopStores {
  return { loops: createLoopStore(), items: createLoopItemLedger(), outputs: createLoopOutputStore() };
}

function shipVia(s: LoopStores): LoopRunnerEffects["ship"] {
  return async ({ loop, output }) => {
    const claimed = await s.outputs.claimShipping(output.id);
    if (!claimed) return null;
    return s.outputs.completeShipping(claimed.id, claimed.claimToken!, { actorId: loop.owner }, { status: "ok" });
  };
}

function effects(s: LoopStores, overrides: Partial<LoopRunnerEffects> = {}): LoopRunnerEffects {
  return {
    enumerate: async () => [{ sourceKey: "SENTRY-1", sourceSummary: "TypeError" }],
    work: async () => ({ runId: "run-1" }),
    captureOutputs: async () => [
      { shipAction: "open_pr", title: "Fix TypeError", capturedBy: "ledger", externalRef: "pr-1" },
    ],
    evaluate: async () => ({ outcome: "met", reason: "PR linked and green", checks: [], judged: true }),
    ship: shipVia(s),
    ...overrides,
  };
}

async function loopIn(s: LoopStores, overrides: Partial<Parameters<typeof s.loops.create>[0]> = {}): Promise<Loop> {
  return s.loops.create({ ...base, ...overrides }).then(({ loop }) => loop);
}

test("a fire enqueues new work and holds the finished output for a person", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const summary = await runLoopFire(loop, s, effects(s));
  assert.equal(summary.enqueued, 1);
  assert.equal(summary.worked, 1);
  assert.equal(summary.ready.length, 1);
  assert.deepEqual(summary.shipped, []);
  assert.equal((await s.outputs.awaitingReview(loop.id)).length, 1);
  assert.equal(fireNeedsAttention(summary), true);
});

test("firing twice over the same source never works the item twice", async () => {
  const s = stores();
  const loop = await loopIn(s);
  await runLoopFire(loop, s, effects(s));
  const second = await runLoopFire(loop, s, effects(s));
  assert.equal(second.enqueued, 0);
  assert.equal(second.worked, 0);
  assert.equal((await s.items.byLoop(loop.id)).length, 1);
});

test("a paused loop does not run at all", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const paused = (await s.loops.setState(loop.id, "paused"))!;
  const summary = await runLoopFire(paused, s, effects(s));
  assert.equal(summary.ran, false);
  assert.equal(summary.worked, 0);
  assert.deepEqual(await s.items.byLoop(loop.id), []);
});

test("an unmet condition sends the item back to the queue carrying the judge's reason", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      evaluate: async () => ({ outcome: "continue", reason: "no PR linked yet", checks: [], judged: true }),
    }),
  );
  assert.deepEqual(summary.continued.length, 1);
  const queued = await s.items.queued(loop.id);
  assert.equal(queued[0]?.guidance, "no PR linked yet");
});

test("a parked item does not wedge the queue on the next fire", async () => {
  const s = stores();
  const loop = await loopIn(s);
  await runLoopFire(
    loop,
    s,
    effects(s, { evaluate: async () => ({ outcome: "park", reason: "no reproduction", checks: [], judged: true }) }),
  );
  const second = await runLoopFire(
    loop,
    s,
    effects(s, { enumerate: async () => [{ sourceKey: "SENTRY-1" }, { sourceKey: "SENTRY-2" }] }),
  );
  assert.equal(second.enqueued, 1);
  assert.deepEqual(second.ready.length, 1);
});

test("an auto-gated action ships without a person, and the item closes", async () => {
  const s = stores();
  const loop = await loopIn(s, { shipActions: [{ action: "open_pr", gate: "auto" }] });
  let shipped = 0;
  const doShip = shipVia(s);
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      ship: async (input) => {
        shipped += 1;
        return doShip(input);
      },
    }),
  );
  assert.equal(shipped, 1);
  assert.deepEqual(summary.shipped.length, 1);
  assert.deepEqual(summary.ready, []);
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
});

test("a partial auto-ship parks for human review without superseding or requeueing", async () => {
  const s = stores();
  const loop = await loopIn(s, { shipActions: [{ action: "open_pr", gate: "auto" }] });
  const doShip = shipVia(s);
  let ships = 0;
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      captureOutputs: async () => [
        { shipAction: "open_pr", title: "one", capturedBy: "ledger", externalRef: "pr-1" },
        { shipAction: "open_pr", title: "two", capturedBy: "ledger", externalRef: "pr-2" },
      ],
      ship: async (input) => {
        ships += 1;
        if (ships === 2) throw new Error("provider unavailable");
        return doShip(input);
      },
    }),
  );
  const item = (await s.items.byLoop(loop.id))[0]!;
  const outputs = await s.outputs.byItem(item.id);
  assert.deepEqual(
    outputs.map((output) => output.state),
    ["shipped", "ready"],
  );
  assert.equal(item.status, "ready");
  assert.equal(item.parkedReason, "partial auto-ship: 1 of 2 actions completed before failure — needs human review");
  assert.deepEqual(summary.parked, [item.id]);
  assert.deepEqual(summary.continued, []);
  const next = await runLoopFire(loop, s, effects(s));
  assert.equal(next.worked, 0);
});

test("a standing grant graduates its slice and leaves the rest for review", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const grant = buildShipGrant({
    loopId: loop.id,
    shipAction: "open_pr",
    label: "lint-fix",
    actorId: "U1",
    policyVersion: loop.policyVersion,
  });
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      captureOutputs: async () => [
        { shipAction: "open_pr", title: "lint", capturedBy: "ledger", externalRef: "pr-1", label: "lint-fix" },
        {
          shipAction: "open_pr",
          title: "schema",
          capturedBy: "ledger",
          externalRef: "pr-2",
          label: "schema-migration",
        },
      ],
    }),
    [grant],
  );
  assert.deepEqual(summary.ready.length, 1);
  const waiting = await s.outputs.awaitingReview(loop.id);
  assert.deepEqual(
    waiting.map((o) => o.label),
    ["schema-migration"],
  );
});

test("an undeclared ship action parks the item and is surfaced for the governor", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      captureOutputs: async () => [
        { shipAction: "send_email", title: "emailed the reporter", capturedBy: "ledger", externalRef: "draft-1" },
      ],
    }),
  );
  assert.deepEqual(summary.undeclaredShipActions, ["send_email"]);
  assert.equal(summary.parked.length, 1);
  assert.deepEqual(summary.ready, []);
});

test("the work stage cannot report its own outputs — only the ledger capture can", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const summary = await runLoopFire(loop, s, effects(s, { captureOutputs: async () => [] }));
  assert.deepEqual(await s.outputs.byLoop(loop.id), []);
  assert.deepEqual(summary.ready, []);
});

test("an item that finished without producing anything to ship does not sit on the review dock", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const summary = await runLoopFire(loop, s, effects(s, { captureOutputs: async () => [] }));
  assert.deepEqual(summary.shipped.length, 1);
  assert.equal((await s.items.get(summary.shipped[0]!))?.status, "shipped");
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
});

test("a failing item is retried until its attempt cap, then parked", async () => {
  const s = stores();
  const loop = await loopIn(s, { caps: { maxItemAttempts: 2 } });
  const boom = effects(s, {
    work: async () => {
      throw new Error("sandbox died");
    },
  });
  const first = await runLoopFire(loop, s, boom);
  assert.equal(first.continued.length, 1);
  assert.deepEqual(first.failures, ["SENTRY-1: sandbox died"]);
  const second = await runLoopFire(loop, s, boom);
  assert.equal(second.parked.length, 1);
  assert.equal((await s.items.get(second.parked[0]!))?.parkedReason, "sandbox died");
});

test("a failing item without an explicit cap parks at the default attempt limit", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const boom = effects(s, {
    work: async () => {
      throw new Error("sandbox died");
    },
  });
  await runLoopFire(loop, s, boom);
  await runLoopFire(loop, s, boom);
  const third = await runLoopFire(loop, s, boom);
  assert.equal(third.parked.length, 1);
  assert.equal((await s.items.get(third.parked[0]!))?.attempts, 3);
});

test("intake failing does not count as items worked and marks the fire failed", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      enumerate: async () => {
        throw new Error("sentry 503");
      },
    }),
  );
  assert.equal(summary.worked, 0);
  assert.match(summary.failures[0]!, /sentry 503/);
  assert.equal((await s.loops.get(loop.id))?.consecutiveFailedFires, 1);
});

test("unresolved outputs in every active state count toward the intake throttle", async () => {
  const s = stores();
  const loop = await loopIn(s, { caps: { maxOpenOutputs: 2 } });
  const states = ["ready", "shipping", "unconfirmed"] as const;
  for (const state of states) {
    const { item } = await s.items.enqueue({ loopId: loop.id, sourceKey: state });
    const output = await s.outputs.capture({
      loopId: loop.id,
      itemId: item.id,
      attemptId: state,
      shipAction: "open_pr",
      title: state,
      capturedBy: "ledger",
    });
    await s.outputs.promoteAttempt(item.id, state);
    if (state !== "ready") {
      const claimed = await s.outputs.claimShipping(output.id);
      if (state === "unconfirmed") await s.outputs.markUnconfirmed(output.id, claimed!.claimToken!);
    }
  }
  const summary = await runLoopFire(loop, s, effects(s));
  assert.match(summary.throttled!, /3 outputs/);
  assert.equal(summary.worked, 0);
});

test("an intake failure still drains work that was already queued", async () => {
  const s = stores();
  const loop = await loopIn(s);
  await s.items.enqueue({ loopId: loop.id, sourceKey: "queued-before-fire" });
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      enumerate: async () => {
        throw new Error("sentry 503");
      },
    }),
  );
  assert.equal(summary.worked, 1);
  assert.match(summary.failures[0]!, /sentry 503/);
  assert.equal((await s.loops.get(loop.id))?.consecutiveFailedFires, 1);
});

test("a cap on items per fire bounds the batch and leaves the rest queued", async () => {
  const s = stores();
  const loop = await loopIn(s, { caps: { maxItemsPerFire: 2 } });
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, { enumerate: async () => [{ sourceKey: "A" }, { sourceKey: "B" }, { sourceKey: "C" }] }),
  );
  assert.equal(summary.enqueued, 3);
  assert.equal(summary.worked, 2);
  assert.equal((await s.items.queued(loop.id)).length, 1);
});

test("a reclaimed stale claim cannot promote or auto-ship its outputs", async () => {
  const s = stores();
  const loop = await loopIn(s, { shipActions: [{ action: "open_pr", gate: "auto" }] });
  let shipped = 0;
  const summary = await runLoopFire(
    loop,
    s,
    effects(s, {
      captureOutputs: async ({ item }) => {
        await s.items.claim(item.id, (item.claimedAt ?? 0) + 600_000);
        return [{ shipAction: "open_pr", title: "stale", capturedBy: "ledger", externalRef: "stale-pr" }];
      },
      ship: async () => {
        shipped += 1;
        return null;
      },
    }),
  );
  assert.equal(shipped, 0);
  assert.deepEqual(summary.ready, []);
  assert.deepEqual(summary.shipped, []);
  assert.equal((await s.outputs.byLoop(loop.id))[0]?.state, "superseded");
});

test("an attempt is fenced on the item before its outputs become ready", async () => {
  const s = stores();
  const loop = await loopIn(s);
  const promote = s.outputs.promoteAttempt.bind(s.outputs);
  let itemStatusAtPromotion: string | undefined;
  s.outputs.promoteAttempt = async (itemId, attemptId) => {
    itemStatusAtPromotion = (await s.items.get(itemId))?.status;
    return promote(itemId, attemptId);
  };
  await runLoopFire(loop, s, effects(s));
  assert.equal(itemStatusAtPromotion, "ready");
});

test("a structural governor throttle halves the effective intake batch", async () => {
  const s = stores();
  const loop = await loopIn(s, { caps: { maxItemsPerFire: 4 } });
  const throttled = (await s.loops.setHealth(loop.id, "degraded", "9 items queued", true))!;
  const summary = await runLoopFire(
    throttled,
    s,
    effects(s, { enumerate: async () => ["A", "B", "C", "D"].map((sourceKey) => ({ sourceKey })) }),
  );
  assert.equal(summary.worked, 2);
  assert.equal((await s.items.queued(loop.id)).length, 2);
});

test("a quiet fire that needs nobody says so", async () => {
  const s = stores();
  const loop = await loopIn(s, { shipActions: [{ action: "open_pr", gate: "auto" }] });
  const summary = await runLoopFire(loop, s, effects(s));
  assert.equal(fireNeedsAttention(summary), false);
});
