import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import type { ToolLedger } from "../src/runs/tool-ledger.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
function turn(text: string, surface?: string): OrchestratorInput {
  return {
    actor,
    conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
    origin: { kind: "direct" },
    text,
    ...(surface ? { surface } : {}),
  };
}

type Backend = { name: string; make: () => { runs: RunStore; ledger: ToolLedger } };
const backends: Backend[] = [{ name: "memory", make: () => createMemoryRunStore() }];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const backend of backends) {
  test(`[${backend.name}] enqueue dedups by dedup key`, async () => {
    const { runs } = backend.make();
    const a = await runs.enqueue({ sessionId: "s1", request: turn("hi"), dedupKey: "k1" });
    const b = await runs.enqueue({ sessionId: "s1", request: turn("hi again"), dedupKey: "k1" });
    assert.equal(a.deduped, false);
    assert.equal(b.deduped, true);
    assert.equal(b.run.id, a.run.id);
    const c = await runs.enqueue({ sessionId: "s1", request: turn("fresh"), dedupKey: "k2" });
    assert.notEqual(c.run.id, a.run.id);
  });

  test(`[${backend.name}] activeForThread returns the in-flight run, null once terminal`, async () => {
    const { runs } = backend.make();
    assert.equal(await runs.activeForThread("sX"), null, "nothing running");
    const r = (await runs.enqueue({ sessionId: "sX", request: turn("go") })).run;
    assert.equal((await runs.activeForThread("sX"))?.id, r.id, "pending run is active");
    assert.equal(await runs.activeForThread("other"), null, "scoped to the thread");
    const claimed = await runs.claim("w1", 5_000);
    assert.equal(claimed?.id, r.id);
    assert.equal((await runs.activeForThread("sX"))?.id, r.id, "running run is active");
    await runs.complete(r.id, claimed?.leaseToken ?? "", { status: "ok", reply: "done" });
    assert.equal(await runs.activeForThread("sX"), null, "terminal run is not active");
  });

  test(`[${backend.name}] inFlightForThread puts the running turn first and the queue behind it`, async () => {
    const { runs } = backend.make();
    assert.deepEqual(await runs.inFlightForThread("sQ"), [], "nothing in flight");
    const first = (await runs.enqueue({ sessionId: "sQ", request: turn("first") })).run;
    const second = (await runs.enqueue({ sessionId: "sQ", request: turn("second") })).run;
    const third = (await runs.enqueue({ sessionId: "sQ", request: turn("third") })).run;
    const claimed = await runs.claim("w1", 5_000);
    assert.equal(claimed?.id, first.id, "the oldest run takes the session's one running slot");
    assert.deepEqual(
      (await runs.inFlightForThread("sQ")).map((r) => r.id),
      [first.id, second.id, third.id],
      "oldest first: the live turn, then what is queued behind it in send order",
    );
    assert.deepEqual(await runs.inFlightForThread("other"), [], "scoped to the thread");
    await runs.complete(first.id, claimed?.leaseToken ?? "", { status: "ok", reply: "done" });
    assert.deepEqual(
      (await runs.inFlightForThread("sQ")).map((r) => r.id),
      [second.id, third.id],
      "a finished turn leaves the list; the queue keeps its order",
    );
  });

  test(`[${backend.name}] same-instant submissions keep send order, and the claim takes the displayed head`, async () => {
    const { runs } = backend.make();
    // Six enqueues inside (usually) one millisecond: createdAt ties, so FIFO here is only as
    // real as the store's tie handling. Send order must survive, and the worker must take
    // exactly the head the queue displays.
    const created = [];
    for (let i = 0; i < 6; i++) created.push((await runs.enqueue({ sessionId: "sT", request: turn(`m${i}`) })).run);
    const expected = created.map((r) => r.id);
    assert.deepEqual(
      (await runs.inFlightForThread("sT")).map((r) => r.id),
      expected,
      "the queue reads back in send order even when createdAt ties",
    );
    const claimed = await runs.claim("w1", 5_000);
    assert.equal(claimed?.id, expected[0], "the worker claims exactly the head the queue displays");
  });

  test(`[${backend.name}] withdraw drops a queued run and refuses one already claimed`, async () => {
    const { runs } = backend.make();
    const live = (await runs.enqueue({ sessionId: "sW", request: turn("live") })).run;
    const queued = (await runs.enqueue({ sessionId: "sW", request: turn("queued") })).run;
    assert.ok(await runs.claim("w1", 5_000));
    assert.equal(await runs.withdraw(queued.id), true, "a run that has not started can be withdrawn");
    assert.equal(await runs.get(queued.id), null, "and it is gone, so no worker can ever claim it");
    assert.equal(await runs.withdraw(queued.id), false, "withdrawing it twice is not a second removal");
    assert.equal(await runs.withdraw(live.id), false, "a running turn cannot be un-sent");
    assert.equal((await runs.get(live.id))?.status, "running", "and is left untouched");
    assert.deepEqual(
      (await runs.inFlightForThread("sW")).map((r) => r.id),
      [live.id],
    );
  });

  test(`[${backend.name}] a withdrawn run frees its dedup key`, async () => {
    const { runs } = backend.make();
    const first = (await runs.enqueue({ sessionId: "sD", request: turn("once"), dedupKey: "k" })).run;
    assert.equal(await runs.withdraw(first.id), true);
    const again = await runs.enqueue({ sessionId: "sD", request: turn("once"), dedupKey: "k" });
    assert.equal(again.deduped, false, "the key is free again — a withdrawn turn can be re-sent");
    assert.notEqual(again.run.id, first.id);
  });

  test(`[${backend.name}] activeSessionIds lists distinct in-flight sessions, drops terminal ones`, async () => {
    const { runs } = backend.make();
    assert.deepEqual(await runs.activeSessionIds(), [], "nothing in flight");

    const a = (await runs.enqueue({ sessionId: "sA", request: turn("a") })).run;
    await runs.enqueue({ sessionId: "sB", request: turn("b") });
    await runs.enqueue({ sessionId: "sB", request: turn("b2") });
    assert.deepEqual([...(await runs.activeSessionIds())].sort(), ["sA", "sB"], "pending counts, deduped per session");

    const claimed = await runs.claim("w1", 5_000);
    assert.equal(claimed?.id, a.id);
    assert.deepEqual([...(await runs.activeSessionIds())].sort(), ["sA", "sB"], "running still counts");

    await runs.complete(a.id, claimed?.leaseToken ?? "", { status: "ok", reply: "done" });
    assert.deepEqual(await runs.activeSessionIds(), ["sB"], "completed session drops out; sB still queued");
  });

  test(`[${backend.name}] claim is one-run-per-session and FIFO`, async () => {
    const { runs } = backend.make();
    const r1 = (await runs.enqueue({ sessionId: "sA", request: turn("1") })).run;
    await runs.enqueue({ sessionId: "sA", request: turn("2") });
    const rB = (await runs.enqueue({ sessionId: "sB", request: turn("b") })).run;

    const first = await runs.claim("w1", 5_000);
    assert.equal(first?.id, r1.id, "oldest pending claimed first");
    assert.equal(first?.status, "running");
    assert.ok(first?.leaseToken);

    const second = await runs.claim("w2", 5_000);
    assert.equal(second?.id, rB.id);

    assert.equal(await runs.claim("w3", 5_000), null);
  });

  test(`[${backend.name}] lease fencing on heartbeat/complete`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    const claimed = await runs.claim("w1", 5_000);
    const token = claimed?.leaseToken ?? "";
    assert.ok(token);

    assert.equal(await runs.heartbeat(r.id, "wrong-token", 5_000), false);
    assert.equal(await runs.heartbeat(r.id, token, 5_000), true);

    assert.equal(await runs.complete(r.id, "wrong-token", { status: "ok", reply: "x" }), false);
    assert.equal((await runs.get(r.id))?.status, "running");
    assert.equal(await runs.complete(r.id, token, { status: "ok", reply: "done" }), true);
    const done = await runs.get(r.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.result?.reply, "done");
    assert.equal(done?.leaseToken, null);
  });

  test(`[${backend.name}] releaseLease (deploy drain) hands the run back as a retry without spending budget`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("long turn") })).run;
    const claimed = await runs.claim("w1", 60_000);
    const token = claimed?.leaseToken ?? "";
    assert.ok(token);
    assert.equal(claimed?.attempts, 1);

    assert.equal(await runs.releaseLease(r.id, token), true);
    const released = await runs.get(r.id);
    assert.equal(released?.status, "pending", "released immediately, not after TTL");
    assert.equal(released?.leaseToken, null);
    assert.equal(released?.leaseExpiresAt, null);
    assert.equal(released?.workerId, null);
    assert.equal(released?.attempts, 1, "claim count untouched");
    assert.equal(released?.errorAttempts, 0, "a drain is not an error");

    const reclaimed = await runs.claim("w2", 60_000);
    assert.equal(reclaimed?.id, r.id);
    assert.equal(reclaimed?.attempts, 2, "reclaim treated as a retry");
    assert.equal(reclaimed?.errorAttempts, 0);
  });

  test(`[${backend.name}] releaseLease with a wrong/stale token is a no-op`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    const claimed = await runs.claim("w1", 60_000);
    const token = claimed?.leaseToken ?? "";
    assert.ok(token);

    assert.equal(await runs.releaseLease(r.id, "wrong-token"), false, "stale token releases nothing");
    assert.equal((await runs.get(r.id))?.status, "running", "run untouched");
    assert.equal((await runs.get(r.id))?.leaseToken, token);

    assert.equal(await runs.complete(r.id, token, { status: "ok", reply: "done" }), true);
    assert.equal(await runs.releaseLease(r.id, token), false, "a completed run is not released back to pending");
    assert.equal((await runs.get(r.id))?.status, "done");
  });

  test(`[${backend.name}] waitFor resolves when the run completes`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    const claimed = await runs.claim("w1", 5_000);
    const pending = runs.waitFor(r.id, 2_000);
    await runs.complete(r.id, claimed?.leaseToken ?? "", { status: "ok", reply: "ok" });
    const finished = await pending;
    assert.equal(finished.status, "done");
    assert.equal(finished.result?.reply, "ok");
  });

  test(`[${backend.name}] non-retryable failure parks the run immediately`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi"), maxAttempts: 3 })).run;
    const claimed = await runs.claim("w1", 5_000);
    const token = claimed?.leaseToken ?? "";
    assert.ok(token);

    assert.deepEqual(await runs.fail(r.id, token, "provider rejected the request", { retry: false }), {
      requeued: false,
    });
    const failed = await runs.get(r.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempts, 1);
    assert.equal(failed?.result?.status, "failed");
    assert.equal(failed?.result?.reason, "provider rejected the request");
  });

  test(`[${backend.name}] reaper does not requeue a run that completed after its lease expired`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    const claimed = await runs.claim("w1", 1);
    const token = claimed?.leaseToken ?? "";
    assert.ok(token);
    await sleep(10);

    assert.equal(await runs.complete(r.id, token, { status: "ok", reply: "won" }), true);
    const swept = await runs.reapExpired();
    assert.deepEqual(swept, { requeued: 0, parked: 0 });
    const done = await runs.get(r.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.result?.reply, "won");
  });

  test(`[${backend.name}] reaper does not requeue a run whose lease was renewed mid-sweep`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    const claimed = await runs.claim("w1", 1);
    const token = claimed?.leaseToken ?? "";
    assert.ok(token);
    await sleep(10);

    assert.equal(await runs.heartbeat(r.id, token, 60_000), true);
    const swept = await runs.reapExpired();
    assert.deepEqual(swept, { requeued: 0, parked: 0 });
    assert.equal((await runs.get(r.id))?.status, "running");
  });

  test(`[${backend.name}] reaper parks (not requeues) a run older than the durable age cap`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("poison") })).run;
    const claimed = await runs.claim("w1", 1);
    assert.ok(claimed?.leaseToken);
    await sleep(15);

    const events: import("../src/runs/run-store.ts").ReapEvent[] = [];
    const swept = await runs.reapExpired(undefined, { maxAgeMs: 5, onReap: (e) => events.push(e) });
    assert.deepEqual(swept, { requeued: 0, parked: 1 }, "an over-age run is parked, not requeued");
    const parked = await runs.get(r.id);
    assert.equal(parked?.status, "failed", "parked run is terminal failed (loud)");
    assert.match(parked?.result?.reason ?? "", /max age/);
    assert.equal(parked?.errorAttempts, 0, "age-cap park does not burn the error budget");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.outcome, "parked");
    assert.equal(events[0]?.runId, r.id);
    assert.equal(events[0]?.sessionId, "s1");
    assert.equal(events[0]?.workerId, "w1");
    assert.equal(events[0]?.attempts, 1);
    assert.equal(events[0]?.errorAttempts, 0);
  });

  test(`[${backend.name}] reaper requeues (not parks) a run younger than the age cap, and reports it`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("normal") })).run;
    const claimed = await runs.claim("w1", 1);
    assert.ok(claimed?.leaseToken);
    await sleep(10);

    const events: import("../src/runs/run-store.ts").ReapEvent[] = [];
    const swept = await runs.reapExpired(undefined, { maxAgeMs: 60_000, onReap: (e) => events.push(e) });
    assert.deepEqual(swept, { requeued: 1, parked: 0 }, "a young expired run still requeues");
    assert.equal((await runs.get(r.id))?.status, "pending");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.outcome, "requeued");
    assert.equal(events[0]?.runId, r.id);
    assert.equal(events[0]?.attempts, 1);
    assert.equal(events[0]?.errorAttempts, 0);
  });

  test(`[${backend.name}] delivery state round-trips and survives to the terminal run`, async () => {
    const { runs } = backend.make();
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    assert.equal(r.deliveryState, null);
    assert.equal(await runs.setDeliveryState("nope", null, { editRef: "1.2" }), false);
    assert.equal(await runs.setDeliveryState(r.id, null, { editRef: "171.002" }), true);

    const claimed = await runs.claim("w1", 5_000);
    assert.equal(await runs.setDeliveryState(r.id, "wrong-token", { editRef: "999.999" }), false);
    assert.equal((await runs.get(r.id))?.deliveryState?.editRef, "171.002");
    assert.equal(await runs.setDeliveryState(r.id, claimed?.leaseToken ?? "", { editRef: "171.003" }), true);
    assert.equal((await runs.get(r.id))?.deliveryState?.editRef, "171.003");
    const seen: string[] = [];
    runs.onTerminal((run) => seen.push(`${run.id}:${run.status}:${run.deliveryState?.editRef ?? ""}`));
    await runs.complete(r.id, claimed?.leaseToken ?? "", { status: "ok", reply: "done" });
    assert.deepEqual(seen, [`${r.id}:done:171.003`], "terminal listener sees the checkpointed state");
    assert.equal((await runs.get(r.id))?.deliveryState?.editRef, "171.003");
  });

  test(`[${backend.name}] onTerminal fires once per terminal transition, including a parked fail`, async () => {
    const { runs } = backend.make();
    const seen: string[] = [];
    runs.onTerminal((run) => seen.push(`${run.id}:${run.status}`));

    const ok = (await runs.enqueue({ sessionId: "sA", request: turn("a") })).run;
    const okClaim = await runs.claim("w1", 5_000);
    await runs.complete(ok.id, okClaim?.leaseToken ?? "", { status: "ok", reply: "x" });

    const retried = (await runs.enqueue({ sessionId: "sB", request: turn("b"), maxAttempts: 2 })).run;
    const c1 = await runs.claim("w2", 5_000);
    await runs.fail(retried.id, c1?.leaseToken ?? "", "boom", { retry: true });
    assert.deepEqual(seen, [`${ok.id}:done`], "a requeued attempt is not terminal");
    const c2 = await runs.claim("w2", 5_000);
    await runs.fail(retried.id, c2?.leaseToken ?? "", "boom again", { retry: true });
    assert.deepEqual(seen, [`${ok.id}:done`, `${retried.id}:failed`], "exhausted attempts park the run and fire");
  });

  test(`[${backend.name}] ledger caches a side effect's output by (runId, attempt, callIndex)`, async () => {
    const { ledger } = backend.make();
    assert.equal((await ledger.begin("run1", 1, 0)).cached, false);
    await ledger.record("run1", 1, 0, JSON.stringify({ ok: true }));
    const again = await ledger.begin("run1", 1, 0);
    assert.equal(again.cached, true);
    assert.deepEqual(JSON.parse(again.output ?? "null"), { ok: true });
    assert.equal((await ledger.begin("run1", 1, 1)).cached, false);
  });

  test(`[${backend.name}] ledger keys on attempt: attempt 2's call 0 does NOT see attempt 1's call-0 output`, async () => {
    const { ledger } = backend.make();
    await ledger.record("run1", 1, 0, JSON.stringify({ cmd: "attempt-1" }));
    const fresh = await ledger.begin("run1", 2, 0);
    assert.equal(fresh.cached, false, "attempt 2 call 0 must not read attempt 1 call 0");
    await ledger.record("run1", 2, 0, JSON.stringify({ cmd: "attempt-2" }));
    const replay = await ledger.begin("run1", 2, 0);
    assert.equal(replay.cached, true, "same-attempt replay dedupes");
    assert.deepEqual(JSON.parse(replay.output ?? "null"), { cmd: "attempt-2" });
    const a1 = await ledger.begin("run1", 1, 0);
    assert.deepEqual(JSON.parse(a1.output ?? "null"), { cmd: "attempt-1" });
  });
}
