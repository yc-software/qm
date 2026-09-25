import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { collectVitals, evaluateGovernor } from "../src/loops/governor.ts";
import { scopeId } from "../src/types.ts";

const captured = {
  loopId: "L1",
  itemId: "I1",
  attemptId: "A1",
  shipAction: "open_pr",
  title: "Fix TypeError in checkout",
  capturedBy: "ledger" as const,
  externalRef: "https://github.com/acme/app/pull/12",
};

async function captureReady(outputs: ReturnType<typeof createLoopOutputStore>, input = captured) {
  const output = await outputs.capture(input);
  await outputs.promoteAttempt(output.itemId, output.attemptId);
  return (await outputs.get(output.id))!;
}

test("a captured output stays staged until its attempt succeeds", async () => {
  const outputs = createLoopOutputStore();
  const output = await outputs.capture(captured);
  assert.equal(output.state, "staged");
  assert.deepEqual(await outputs.awaitingReview("L1"), []);
  const [ready] = await outputs.promoteAttempt("I1", "A1");
  assert.equal(ready?.state, "ready");
  assert.deepEqual(
    (await outputs.awaitingReview("L1")).map((o) => o.id),
    [output.id],
  );
});

test("capturing the same artifact twice in one attempt is idempotent", async () => {
  const outputs = createLoopOutputStore();
  const first = await outputs.capture(captured);
  const second = await outputs.capture({ ...captured, title: "Fix TypeError in checkout (updated)" });
  assert.equal(second.id, first.id);
  assert.equal((await outputs.byLoop("L1")).length, 1);
});

test("same-action artifacts in one attempt use their response ordinal", async () => {
  const outputs = createLoopOutputStore();
  const artifact = { ...captured, externalRef: undefined };
  const first = await outputs.capture({ ...artifact, ordinal: 0, title: "first" });
  const second = await outputs.capture({ ...artifact, ordinal: 1, title: "second" });
  const replay = await outputs.capture({ ...artifact, ordinal: 1, title: "second" });
  assert.notEqual(first.id, second.id);
  assert.equal(replay.id, second.id);
  assert.equal((await outputs.byLoop("L1")).length, 2);
});

test("a retry gets a new output and supersession links", async () => {
  const outputs = createLoopOutputStore();
  const first = await outputs.capture(captured);
  const second = await outputs.capture({ ...captured, attemptId: "A2" });
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.supersedesOutputIds, [first.id]);
  assert.deepEqual((await outputs.get(first.id))?.supersededByOutputIds, [second.id]);
});

test("the classifier relabels an output without disturbing the human decision", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const classified = await outputs.classify(output.id, { label: "lint-fix", summary: "one-line null guard" });
  assert.equal(classified?.label, "lint-fix");
  assert.equal(classified?.state, "ready");
});

test("shipping records who decided it and closes the output", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const claimed = await outputs.claimShipping(output.id);
  const shipped = await outputs.completeShipping(output.id, claimed!.claimToken!, { actorId: "U1" }, { reply: "done" });
  assert.equal(shipped?.state, "shipped");
  assert.equal(shipped?.decidedBy, "U1");
  assert.deepEqual(await outputs.awaitingReview("L1"), []);
});

test("an output is decided once — a second decision cannot flip it", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const claimed = await outputs.claimShipping(output.id);
  await outputs.completeShipping(output.id, claimed!.claimToken!, { actorId: "U1" }, { reply: "done" });
  assert.equal(await outputs.returnToLoop(output.id, { actorId: "U2" }), null);
});

test("returning an output carries the reviewer's note back to the loop", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const returned = await outputs.returnToLoop(output.id, { actorId: "U1", note: "touches the wrong module" });
  assert.equal(returned?.state, "returned");
  assert.equal(returned?.decisionNote, "touches the wrong module");
});

test("stale held work expires instead of sitting on the dock forever", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  assert.deepEqual(await outputs.expireOlderThan("L1", output.createdAt), []);
  const expired = await outputs.expireOlderThan("L1", output.createdAt + 1);
  assert.deepEqual(
    expired.map((o) => o.state),
    ["expired"],
  );
});

test("vitals assembled from the stores drive the governor to quarantine on an undeclared action", async () => {
  const { loop } = await createLoopStore().create({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    name: "Sentry triage",
    playbook: "fix the issue",
    successCondition: "a PR is linked",
    shipActions: [{ action: "open_pr", gate: "hold" }],
  });
  const items = createLoopItemLedger();
  const outputs = createLoopOutputStore();
  const { item } = await items.enqueue({ loopId: loop.id, sourceKey: "SENTRY-1" });
  await captureReady(outputs, { ...captured, loopId: loop.id, itemId: item.id });
  await captureReady(outputs, {
    ...captured,
    loopId: loop.id,
    itemId: item.id,
    shipAction: "send_email",
    externalRef: "draft-9",
  });

  const vitals = await collectVitals(loop, { items, outputs }, Date.now());
  assert.deepEqual(vitals.undeclaredShipActions, ["send_email"]);
  assert.equal(vitals.openOutputs, 2);
  assert.equal(evaluateGovernor(loop, vitals, Date.now()).health, "quarantined");
});

test("undeclared ship actions affect vitals only while their outputs are active", async () => {
  const { loop } = await createLoopStore().create({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    name: "Sentry triage",
    playbook: "fix the issue",
    successCondition: "a PR is linked",
    shipActions: [{ action: "open_pr", gate: "hold" }],
  });
  const items = createLoopItemLedger();
  const outputs = createLoopOutputStore();
  const shipped = await captureReady(outputs, { ...captured, loopId: loop.id, shipAction: "send_email" });
  const claim = await outputs.claimShipping(shipped.id);
  await outputs.completeShipping(shipped.id, claim!.claimToken!, { actorId: "U1" }, { status: "ok" });
  assert.equal((await collectVitals(loop, { items, outputs }, Date.now())).undeclaredShipActions, undefined);
  await captureReady(outputs, { ...captured, loopId: loop.id, externalRef: "active", shipAction: "send_email" });
  assert.deepEqual((await collectVitals(loop, { items, outputs }, Date.now())).undeclaredShipActions, ["send_email"]);
});

test("vitals count the return rate only from outputs a person actually decided", async () => {
  const { loop } = await createLoopStore().create({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    name: "Front replies",
    playbook: "answer the ticket",
    successCondition: "the reply answers the question",
    shipActions: [{ action: "front_reply", gate: "hold" }],
  });
  const items = createLoopItemLedger();
  const outputs = createLoopOutputStore();
  for (const ref of ["a", "b", "c"]) {
    const out = await outputs.capture({
      loopId: loop.id,
      itemId: `item-${ref}`,
      attemptId: `attempt-${ref}`,
      shipAction: "front_reply",
      title: `reply ${ref}`,
      capturedBy: "ledger",
      externalRef: ref,
    });
    await outputs.promoteAttempt(out.itemId, out.attemptId);
    if (ref !== "c") await outputs.returnToLoop(out.id, { actorId: "U1" });
  }
  const vitals = await collectVitals(loop, { items, outputs }, Date.now());
  assert.equal(vitals.decidedOutputs, 2);
  assert.equal(vitals.returnedOutputs, 2);
  assert.equal(vitals.openOutputs, 1);
});

test("unconfirmed undeclared outputs remain open and trigger quarantine", async () => {
  const { loop } = await createLoopStore().create({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    name: "Sentry triage",
    playbook: "fix the issue",
    successCondition: "a PR is linked",
    shipActions: [{ action: "open_pr", gate: "hold" }],
  });
  const items = createLoopItemLedger();
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs, { ...captured, loopId: loop.id, shipAction: "send_email" });
  const claimed = await outputs.claimShipping(output.id);
  await outputs.markUnconfirmed(output.id, claimed!.claimToken!);
  const vitals = await collectVitals(loop, { items, outputs }, Date.now());
  assert.equal(vitals.openOutputs, 1);
  assert.deepEqual(vitals.undeclaredShipActions, ["send_email"]);
});

test("superseding active siblings includes unconfirmed outputs", async () => {
  const outputs = createLoopOutputStore();
  const first = await captureReady(outputs, captured);
  const second = await captureReady(outputs, { ...captured, externalRef: "second" });
  const claimed = await outputs.claimShipping(second.id);
  await outputs.markUnconfirmed(second.id, claimed!.claimToken!);
  await outputs.supersedeActiveSiblings(first.itemId, first.id);
  assert.equal((await outputs.get(second.id))?.state, "superseded");
});

test("two racing ship claims on one output yield exactly one winner", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const [first, second] = await Promise.all([outputs.claimShipping(output.id), outputs.claimShipping(output.id)]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal((await outputs.get(output.id))?.state, "shipping");
});

test("a dead ship claim is recoverable after its lease expires", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const claimed = await outputs.claimShipping(output.id);
  assert.ok(claimed);
  assert.equal(await outputs.claimShipping(output.id), null);
  const recovered = await outputs.claimShipping(output.id, (claimed?.claimedAt ?? 0) + 600_000);
  assert.ok(recovered);
});

test("a stale shipping claim cannot complete after the lease is reclaimed", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const stale = await outputs.claimShipping(output.id, 1_000);
  const current = await outputs.claimShipping(output.id, 601_000);
  assert.ok(current);
  assert.notEqual(current.claimToken, stale?.claimToken);
  assert.equal(
    await outputs.completeShipping(output.id, stale!.claimToken!, { actorId: "U1" }, { reply: "stale" }),
    null,
  );
  assert.equal((await outputs.get(output.id))?.claimToken, current.claimToken);
  assert.equal((await outputs.get(output.id))?.state, "shipping");
});

test("a failed ship attempt returns the output to the review dock", async () => {
  const outputs = createLoopOutputStore();
  const output = await captureReady(outputs);
  const claimed = await outputs.claimShipping(output.id);
  const back = await outputs.failShipping(output.id, claimed!.claimToken!);
  assert.equal(back?.state, "ready");
  assert.equal((await outputs.awaitingReview("L1")).length, 1);
});
