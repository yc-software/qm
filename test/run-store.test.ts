import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { isUnstarted } from "../src/runs/run-store.ts";
import { claimTurn, finishTurn, testRunStore, type TestRunStore } from "./support/turns.ts";

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

async function withStore(body: (store: TestRunStore) => Promise<void>): Promise<void> {
  const store = testRunStore();
  try {
    await body(store);
  } finally {
    await store.close();
  }
}

test("conversation lookup includes independent tasks and status context but excludes neighboring DMs", () =>
  withStore(async ({ runs }) => {
    for (const ref of ["dm:D1", "dm:D1:task:a", "dm:D1:status:b", "dm:D11:task:c", "dm:D2"]) {
      await runs.enqueue({ sessionId: ref, request: turn(ref) });
    }
    assert.deepEqual((await runs.list({ threadRef: "dm:D1" })).map((run) => run.sessionId).sort(), [
      "dm:D1",
      "dm:D1:status:b",
      "dm:D1:task:a",
    ]);
  }));

test("terminalFinished pages finished runs by (finishedAt, id) within the bound", () =>
  withStore(async ({ runs, ledger }) => {
    const finished: string[] = [];
    for (const ref of ["a", "b", "c"]) {
      const run = (await runs.enqueue({ sessionId: ref, request: turn(ref) })).run;
      await finishTurn((await claimTurn(ledger, run.id))!, { status: "ok", reply: ref });
      finished.push(run.id);
    }
    await runs.enqueue({ sessionId: "pending", request: turn("pending") });
    const running = (await runs.enqueue({ sessionId: "running", request: turn("running") })).run;
    assert.ok(await claimTurn(ledger, running.id));
    const far = Date.now() + 60_000;
    const all = await runs.terminalFinished({ finishedAt: 0, id: "" }, far, 10);
    assert.deepEqual(new Set(all.map((run) => run.id)), new Set(finished), "only terminal runs are listed");
    assert.ok(!all.some((run) => run.id === running.id));
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!;
      const next = all[i]!;
      assert.ok(prev.finishedAt! < next.finishedAt! || (prev.finishedAt === next.finishedAt && prev.id < next.id));
    }
    const first = await runs.terminalFinished({ finishedAt: 0, id: "" }, far, 2);
    const rest = await runs.terminalFinished({ finishedAt: first[1]!.finishedAt!, id: first[1]!.id }, far, 2);
    assert.deepEqual(
      [...first, ...rest].map((run) => run.id),
      all.map((run) => run.id),
      "keyset paging is gapless",
    );
    assert.deepEqual(await runs.terminalFinished({ finishedAt: 0, id: "" }, all[0]!.finishedAt! - 1, 10), []);
  }));

test("enqueue dedups by dedup key", () =>
  withStore(async ({ runs }) => {
    const a = await runs.enqueue({ sessionId: "s1", request: turn("hi"), dedupKey: "k1" });
    const b = await runs.enqueue({ sessionId: "s1", request: turn("hi again"), dedupKey: "k1" });
    assert.equal(a.deduped, false);
    assert.equal(b.deduped, true);
    assert.equal(b.run.id, a.run.id);
    assert.equal((await runs.getByDedupKey("k1"))?.id, a.run.id);
    const c = await runs.enqueue({ sessionId: "s1", request: turn("fresh"), dedupKey: "k2" });
    assert.notEqual(c.run.id, a.run.id);
  }));

test("activeForThread returns the in-flight run, null once terminal", () =>
  withStore(async ({ runs, ledger }) => {
    assert.equal(await runs.activeForThread("sX"), null, "nothing running");
    const r = (await runs.enqueue({ sessionId: "sX", request: turn("go") })).run;
    assert.equal((await runs.activeForThread("sX"))?.id, r.id, "a started run is active");
    assert.equal(await runs.activeForThread("other"), null, "scoped to the thread");
    const claimed = await claimTurn(ledger, r.id);
    assert.ok(claimed);
    assert.equal((await runs.activeForThread("sX"))?.id, r.id, "running run is active");
    await finishTurn(claimed, { status: "ok", reply: "done" });
    assert.equal(await runs.activeForThread("sX"), null, "terminal run is not active");
  }));

test("inFlightForThread puts the live turn first and the queue behind it in send order", () =>
  withStore(async ({ runs, ledger }) => {
    assert.deepEqual(await runs.inFlightForThread("sQ"), [], "nothing in flight");
    // Six enqueues inside (usually) one millisecond: createdAt ties, so send order is only as
    // real as the store's tie handling, and each claim must take exactly the displayed head.
    const created = [];
    for (let i = 0; i < 6; i++) created.push((await runs.enqueue({ sessionId: "sQ", request: turn(`m${i}`) })).run);
    const expected = created.map((r) => r.id);
    assert.deepEqual(
      (await runs.inFlightForThread("sQ")).map((r) => r.id),
      expected,
      "send order survives created_at ties",
    );
    assert.deepEqual(await runs.inFlightForThread("other"), [], "scoped to the thread");
    for (const [i, id] of expected.entries()) {
      const claimed = await claimTurn(ledger);
      assert.equal(claimed?.run.id, id, "each turn starts in the order the queue displays");
      await finishTurn(claimed!, { status: "ok", reply: "done" });
      assert.deepEqual(
        (await runs.inFlightForThread("sQ")).map((r) => r.id),
        expected.slice(i + 1),
        "a finished turn leaves the list; the queue keeps its order",
      );
    }
  }));

test("withdraw drops a queued run and refuses one already claimed", () =>
  withStore(async ({ runs, ledger }) => {
    const live = (await runs.enqueue({ sessionId: "sW", request: turn("live") })).run;
    const queued = (await runs.enqueue({ sessionId: "sW", request: turn("queued") })).run;
    assert.ok(await claimTurn(ledger, live.id));
    assert.equal(await runs.withdraw(queued.id), true, "a run that has not started can be withdrawn");
    assert.equal(await runs.get(queued.id), null, "and it is gone, so no worker can ever claim it");
    assert.equal(await runs.withdraw(queued.id), false, "withdrawing it twice is not a second removal");
    assert.equal(await runs.withdraw(live.id), false, "a running turn cannot be un-sent");
    assert.equal((await runs.get(live.id))?.status, "running", "and is left untouched");
    assert.deepEqual(
      (await runs.inFlightForThread("sW")).map((r) => r.id),
      [live.id],
    );
  }));

test("a withdrawn run frees its dedup key", () =>
  withStore(async ({ runs }) => {
    const first = (await runs.enqueue({ sessionId: "sD", request: turn("once"), dedupKey: "k" })).run;
    assert.equal(await runs.withdraw(first.id), true);
    const again = await runs.enqueue({ sessionId: "sD", request: turn("once"), dedupKey: "k" });
    assert.equal(again.deduped, false, "the key is free again — a withdrawn turn can be re-sent");
    assert.notEqual(again.run.id, first.id);
  }));

test("a run refused as session_busy frees its dedup key; other outcomes keep it", () =>
  withStore(async ({ runs, ledger }) => {
    const busy = (await runs.enqueue({ sessionId: "sE", request: turn("later"), dedupKey: "kb" })).run;
    await finishTurn((await claimTurn(ledger, busy.id))!, {
      status: "refused",
      refusalKind: "session_busy",
      reason: "busy",
    });
    assert.equal((await runs.get(busy.id))?.dedupKey, null);
    const retry = await runs.enqueue({ sessionId: "sE", request: turn("later"), dedupKey: "kb" });
    assert.equal(retry.deduped, false, "a busy refusal never handled the request, so the key is free to run again");
    assert.notEqual(retry.run.id, busy.id);

    await finishTurn((await claimTurn(ledger, retry.run.id))!, { status: "refused", reason: "policy" });
    const dup = await runs.enqueue({ sessionId: "sE", request: turn("later"), dedupKey: "kb" });
    assert.equal(dup.deduped, true, "an ordinary refusal was handled and stays deduped");
  }));

test("activeSessionIds lists distinct in-flight sessions, drops terminal ones", () =>
  withStore(async ({ runs, ledger }) => {
    assert.deepEqual(await runs.activeSessionIds(), [], "nothing in flight");
    const a = (await runs.enqueue({ sessionId: "sA", request: turn("a") })).run;
    await runs.enqueue({ sessionId: "sB", request: turn("b") });
    await runs.enqueue({ sessionId: "sB", request: turn("b2") });
    assert.deepEqual([...(await runs.activeSessionIds())].sort(), ["sA", "sB"], "queued counts, deduped per session");
    const claimed = await claimTurn(ledger, a.id);
    assert.deepEqual([...(await runs.activeSessionIds())].sort(), ["sA", "sB"], "running still counts");
    await finishTurn(claimed!, { status: "ok", reply: "done" });
    assert.deepEqual(await runs.activeSessionIds(), ["sB"], "completed session drops out; sB still queued");
  }));

test("one turn per conversation runs at a time, oldest first, and conversations run side by side", () =>
  withStore(async ({ runs, ledger }) => {
    const r1 = (await runs.enqueue({ sessionId: "sA", request: turn("1") })).run;
    const r2 = (await runs.enqueue({ sessionId: "sA", request: turn("2") })).run;
    const rB = (await runs.enqueue({ sessionId: "sB", request: turn("b") })).run;
    assert.deepEqual(
      [r1.status, r2.status, rB.status],
      ["pending", "queued", "pending"],
      "the second turn waits behind its conversation's active turn with no task of its own",
    );
    assert.equal((await runs.get(r2.id))?.absurdTaskId, null);

    const first = await claimTurn(ledger);
    assert.equal(first?.run.id, r1.id, "oldest pending claimed first");
    assert.equal(first?.run.status, "running");
    assert.equal(first?.run.leaseToken, first?.token);
    const second = await claimTurn(ledger);
    assert.equal(second?.run.id, rB.id, "another conversation is not blocked");
    assert.equal(await claimTurn(ledger), null, "the queued turn cannot start while its conversation is busy");

    await finishTurn(first!, { status: "ok", reply: "done" });
    assert.equal((await runs.get(r2.id))?.status, "pending", "ending the active turn starts the next one");
    assert.equal((await claimTurn(ledger))?.run.id, r2.id);
  }));

test("the claim token fences extend, finish and handback", () =>
  withStore(async ({ runs, ledger }) => {
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    const claimed = (await claimTurn(ledger, r.id))!;
    assert.equal(await runs.leaseHeld(claimed.run, "wrong-token"), false);
    assert.equal(await runs.leaseHeld(claimed.run, claimed.token), true);

    assert.equal(await ledger.extend(claimed.run, "wrong-token"), "lost");
    assert.equal(await ledger.extend(claimed.run, claimed.token), "held");

    assert.equal(await ledger.handBack(claimed.run, "wrong-token", { stop: { kind: "shutdown" } }), false);
    assert.equal(
      await ledger.finish(claimed.run, "wrong-token", { status: "done", result: { status: "ok", reply: "x" } }),
      false,
    );
    const untouched = await runs.get(r.id);
    assert.equal(untouched?.status, "running", "a stale holder changes nothing");
    assert.equal(untouched?.leaseToken, claimed.token);

    assert.equal(await finishTurn(claimed, { status: "ok", reply: "done" }), true);
    const done = await runs.get(r.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.result?.reply, "done");
    assert.equal(done?.leaseToken, null);
    assert.equal(await runs.leaseHeld(claimed.run, claimed.token), false, "a finished turn holds no lease");
    assert.equal(
      await ledger.handBack(claimed.run, claimed.token, { stop: { kind: "shutdown" } }),
      false,
      "a finished turn is not handed back to pending",
    );
    assert.equal((await runs.get(r.id))?.status, "done");
  }));

test("a shutdown handback returns the turn at once as a retry without spending error budget", () =>
  withStore(async ({ runs, ledger }) => {
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("long turn") })).run;
    const claimed = (await claimTurn(ledger, r.id))!;
    assert.equal(claimed.run.attempts, 1);

    assert.equal(await ledger.handBack(claimed.run, claimed.token, { stop: { kind: "shutdown" } }), true);
    const released = await runs.get(r.id);
    assert.equal(released?.status, "pending", "released immediately, not after a claim timeout");
    assert.equal(released?.leaseToken, null);
    assert.equal(released?.workerId, null);
    assert.equal(released?.attempts, 1, "claim count untouched");
    assert.equal(released?.errorAttempts, 0, "a drain is not an error");
    assert.equal(released?.preemptions, 0, "a drain is not a park");

    const reclaimed = await claimTurn(ledger);
    assert.equal(reclaimed?.run.id, r.id);
    assert.equal(reclaimed?.run.attempts, 2, "reclaim treated as a retry");
    assert.equal(reclaimed?.run.errorAttempts, 0);
  }));

test("withdraw and claim cannot both win the same unstarted run", () =>
  withStore(async ({ runs, ledger }) => {
    const live = (await runs.enqueue({ sessionId: "sWd", request: turn("live") })).run;
    assert.ok(await claimTurn(ledger, live.id));
    const queued = (await runs.enqueue({ sessionId: "sWd", request: turn("queued") })).run;
    assert.equal(isUnstarted(queued), true, "a queued turn behind a busy conversation is unstarted");
    const results = await Promise.all(Array.from({ length: 8 }, () => runs.withdraw(queued.id)));
    assert.equal(results.filter(Boolean).length, 1, "exactly one withdrawal wins");
    assert.equal(await runs.get(queued.id), null);

    for (let i = 0; i < 5; i++) {
      const contested = (await runs.enqueue({ sessionId: `sWd-${i}`, request: turn("contested") })).run;
      assert.equal(isUnstarted(contested), true, "a pending turn that never ran is unstarted");
      const [withdrawn, claimed] = await Promise.all([
        runs.withdraw(contested.id, { unstartedOnly: true }),
        claimTurn(ledger, contested.id),
      ]);
      assert.notEqual(withdrawn, Boolean(claimed), "the run is either withdrawn or running, never both");
      const after = await runs.get(contested.id);
      assert.equal(after?.status ?? null, claimed ? "running" : null);
      if (claimed) {
        assert.equal(isUnstarted(after!), false, "a claimed turn is no longer unstarted");
        assert.equal(await runs.withdraw(contested.id, { unstartedOnly: true }), false);
      }
    }
  }));

test("unstarted withdrawal preserves claimed and handed-back turns", () =>
  withStore(async ({ runs, ledger }) => {
    const { run } = await runs.enqueue({ sessionId: "wake-retry", request: turn("completion") });
    const claimed = (await claimTurn(ledger, run.id))!;
    assert.equal(await runs.withdraw(run.id, { unstartedOnly: true }), false);
    await ledger.handBack(claimed.run, claimed.token, { stop: { kind: "shutdown" } });
    const handedBack = (await runs.get(run.id))!;
    assert.equal(handedBack.status, "pending");
    assert.equal(isUnstarted(handedBack), false, "a turn that ran once is not unstarted");
    assert.equal(await runs.withdraw(run.id, { unstartedOnly: true }), false);
    assert.equal((await runs.get(run.id))!.status, "pending");
    const { run: fresh } = await runs.enqueue({ sessionId: "wake-fresh", request: turn("completion") });
    assert.equal(await runs.withdraw(fresh.id, { unstartedOnly: true }), true);
    assert.equal(await runs.get(fresh.id), null);
  }));

test("waitFor resolves when the run completes", () =>
  withStore(async ({ runs, ledger }) => {
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    const claimed = (await claimTurn(ledger, r.id))!;
    const pending = runs.waitFor(r.id, 2_000);
    await finishTurn(claimed, { status: "ok", reply: "ok" });
    const finished = await pending;
    assert.equal(finished.status, "done");
    assert.equal(finished.result?.reply, "ok");
  }));

test("a handed-back turn records why its last attempt stopped", () =>
  withStore(async ({ runs, ledger }) => {
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("long turn") })).run;
    assert.equal((await runs.get(r.id))?.lastStop ?? null, null, "a fresh run has no stop cause");
    const first = (await claimTurn(ledger, r.id))!;
    await ledger.handBack(first.run, first.token, { stop: { kind: "shutdown" } });
    assert.deepEqual((await runs.get(r.id))?.lastStop, { kind: "shutdown" });
    const second = (await claimTurn(ledger, r.id))!;
    const stop = { kind: "error" as const, code: "transient", status: 503 };
    await ledger.handBack(second.run, second.token, { stop, countsAsError: true });
    assert.deepEqual((await runs.get(r.id))?.lastStop, stop);
    const unstarted = (await claimTurn(ledger, r.id))!;
    await ledger.handBack(unstarted.run, unstarted.token, { unstarted: true });
    assert.deepEqual((await runs.get(r.id))?.lastStop, stop, "a handback before the attempt started keeps the cause");
  }));

test("a failed turn keeps its reason and provider error code on the result", () =>
  withStore(async ({ runs, ledger }) => {
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi"), maxAttempts: 1 })).run;
    const claimed = (await claimTurn(ledger, r.id))!;
    await finishTurn(
      claimed,
      { status: "failed", sessionId: "s1", reason: "slow down", errorCode: "rate_limit" },
      "failed",
    );
    const failed = await runs.get(r.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempts, 1);
    assert.deepEqual(failed?.result, {
      status: "failed",
      sessionId: "s1",
      reason: "slow down",
      errorCode: "rate_limit",
    });
  }));

test("delivery state round-trips, is fenced by the claim, and survives to the terminal run", () =>
  withStore(async ({ runs, ledger }) => {
    const r = (await runs.enqueue({ sessionId: "s1", request: turn("hi") })).run;
    assert.equal(r.deliveryState, null);
    assert.equal(await runs.setDeliveryState("nope", null, { editRef: "1.2" }), false);
    assert.equal(await runs.setDeliveryState(r.id, null, { editRef: "171.002" }), true);
    const claimed = (await claimTurn(ledger, r.id))!;
    assert.equal(await runs.setDeliveryState(r.id, "wrong-token", { editRef: "999.999" }), false);
    assert.equal((await runs.get(r.id))?.deliveryState?.editRef, "171.002");
    assert.equal(await runs.setDeliveryState(r.id, claimed.token, { editRef: "171.003" }), true);
    assert.equal((await runs.get(r.id))?.deliveryState?.editRef, "171.003");
    assert.equal(await runs.setDeliveryState(r.id, claimed.token, { replying: true }), true);
    await runs.setDeliveryState(r.id, null, { editRef: "171.003" });
    assert.deepEqual((await runs.get(r.id))?.deliveryState, { editRef: "171.003", replying: true });
    const seen: string[] = [];
    runs.onTerminal((run) => seen.push(`${run.id}:${run.status}:${run.deliveryState?.editRef ?? ""}`));
    await finishTurn(claimed, { status: "ok", reply: "done" });
    assert.deepEqual(seen, [`${r.id}:done:171.003`], "terminal listener sees the checkpointed state");
    assert.equal((await runs.get(r.id))?.deliveryState?.editRef, "171.003");
  }));

test("onTerminal fires once per terminal transition, not for a retried attempt", () =>
  withStore(async ({ runs, ledger }) => {
    const seen: string[] = [];
    runs.onTerminal((run) => seen.push(`${run.id}:${run.status}`));
    const ok = (await runs.enqueue({ sessionId: "sA", request: turn("a") })).run;
    await finishTurn((await claimTurn(ledger, ok.id))!, { status: "ok", reply: "x" });
    const retried = (await runs.enqueue({ sessionId: "sB", request: turn("b"), maxAttempts: 2 })).run;
    const first = (await claimTurn(ledger, retried.id))!;
    await ledger.handBack(first.run, first.token, { stop: { kind: "error" }, countsAsError: true });
    assert.deepEqual(seen, [`${ok.id}:done`], "a requeued attempt is not terminal");
    const second = (await claimTurn(ledger, retried.id))!;
    await finishTurn(second, { status: "failed", reason: "boom again" }, "failed");
    assert.equal(await finishTurn(second, { status: "failed", reason: "twice" }, "failed"), false);
    assert.deepEqual(seen, [`${ok.id}:done`, `${retried.id}:failed`], "the failure fires once");
  }));

test("noteTurnUserSeq records the turn boundary once and never overwrites it", () =>
  withStore(async ({ runs, ledger }) => {
    const run = (await runs.enqueue({ sessionId: "sSeq", request: turn("go") })).run;
    assert.equal(run.turnUserSeq, null);
    assert.equal(await runs.noteTurnUserSeq(run.id, 7), true);
    assert.equal((await runs.get(run.id))?.turnUserSeq, 7);
    assert.equal(await runs.noteTurnUserSeq(run.id, 99), false, "a later attempt must not move the boundary");
    assert.equal((await claimTurn(ledger, run.id))?.run.turnUserSeq, 7, "the claim reads the boundary back");
    assert.equal(await runs.noteTurnUserSeq("missing-run", 1), false);
  }));

test("editing queued text preserves identity, order, attachments and rejects stale or started edits", () =>
  withStore(async ({ runs, ledger }) => {
    const live = (await runs.enqueue({ sessionId: "edits", request: turn("live") })).run;
    const request = {
      ...turn("original"),
      attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 5, blobId: "notes-blob" }],
    };
    const first = (await runs.enqueue({ sessionId: "edits", request, dedupKey: "edit-key" })).run;
    const next = (await runs.enqueue({ sessionId: "edits", request: turn("next") })).run;
    const running = (await claimTurn(ledger, live.id))!;
    assert.equal(await runs.editPendingText(live.id, "too late", "live"), false, "a claimed turn is not editable");
    assert.equal(await runs.editPendingText(first.id, "revised", "original"), true);
    assert.equal(await runs.editPendingText(first.id, "stale", "original"), false);
    const saved = await runs.get(first.id);
    assert.equal(saved?.request.text, "revised");
    assert.equal(saved?.request.displayText, "revised");
    assert.deepEqual(saved?.request.attachments, request.attachments);
    assert.equal(saved?.dedupKey, "edit-key");
    assert.deepEqual(
      (await runs.inFlightForThread("edits")).map((run) => run.id),
      [live.id, first.id, next.id],
    );
    await finishTurn(running, { status: "ok" });
    const claimed = (await claimTurn(ledger, first.id))!;
    assert.equal(claimed.run.request.text, "revised");
    assert.equal(await runs.editPendingText(first.id, "late", "revised"), false, "once claimed it is fixed");
    await ledger.handBack(claimed.run, claimed.token, { stop: { kind: "error" }, countsAsError: true });
    assert.equal(await runs.editPendingText(first.id, "retry edit", "revised"), false);
  }));
