import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoopFireService } from "../src/loops/loop-fire.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { buildShipGrant } from "../src/loops/ship-gate.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";

function fakeIdentity() {
  return {
    refresh: async () => {},
    classify: () => ({ type: "internal" as const }),
  };
}

function fakeDeliveries() {
  const sent: Array<{ text: string }> = [];
  return {
    sent,
    store: {
      enqueue: async (d: { text: string }) => {
        sent.push(d);
        return { id: "d1" };
      },
    },
  };
}

type Responder = (req: TurnRequest) => string;

function service(respond: Responder, overrides?: { grants?: ReturnType<typeof createShipGrantStore> }) {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const outputs = createLoopOutputStore();
  const grants = overrides?.grants ?? createShipGrantStore();
  const deliveries = fakeDeliveries();
  const turns: TurnRequest[] = [];
  const idempotency = createIdempotencyStore();
  const fire = createLoopFireService({
    loops,
    items,
    outputs,
    grants,
    trigger: {
      deliveries: deliveries.store as never,
      idempotency,
      identity: fakeIdentity() as never,
      run: async (req): Promise<TurnResult> => {
        turns.push(req);
        return { status: "ok", reply: respond(req), sessionId: `s${turns.length}` };
      },
    },
  });
  return { loops, items, outputs, grants, fire, turns, deliveries, idempotency };
}

const base = { owner: "josh", createdBy: "josh", ownerScopeId: scopeId("personal", "josh") };

async function makeLoop(loops: ReturnType<typeof createLoopStore>, over: Record<string, unknown> = {}) {
  return loops
    .create({
      ...base,
      name: "Sentry triage",
      playbook: "triage sentry issues",
      successCondition: "a fix PR is linked",
      shipActions: [{ action: "open_pr", gate: "hold" }],
      ...over,
    } as never)
    .then(({ loop }) => loop);
}

function stage(req: TurnRequest): string {
  const text = req.text ?? "";
  if (text.startsWith("[Loop intake]")) return "intake";
  if (text.startsWith("[Loop work]")) return "work";
  if (text.startsWith("[Loop judge]")) return "judge";
  if (text.startsWith("[Loop ship]")) return "ship";
  return "other";
}

const HAPPY: Responder = (req) => {
  switch (stage(req)) {
    case "intake":
      return '```json\n[{"sourceKey": "SENTRY-1", "sourceSummary": "TypeError in checkout"}]\n```';
    case "work":
      return 'Prepared a draft PR.\n```json\n{"outputs": [{"shipAction": "open_pr", "title": "Fix TypeError", "externalRef": "https://github.com/x/pull/1", "label": "checkout"}]}\n```';
    case "judge":
      return '```json\n{"outcome": "met", "reason": "draft PR linked"}\n```';
    default:
      return "done";
  }
};

test("a fire runs intake, work, and judge turns and holds the finished output", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  const result = await s.fire.fire(loop.id, "f1");
  assert.equal(result.status, "ok");
  assert.equal(result.summary?.enqueued, 1);
  assert.deepEqual(result.summary?.ready.length, 1);
  const outputs = await s.outputs.awaitingReview(loop.id);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.title, "Fix TypeError");
  assert.equal(outputs[0]?.capturedBy, "agent");
  assert.deepEqual(s.turns.map(stage), ["intake", "work", "judge"]);
});

test("a playbook that points at its own loop reaches the agent with the real id", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    playbook: "GET $AGENT_API_URL/v1/loops/$LOOP_ID/items, then POST $AGENT_API_URL/v1/loops/$LOOP_ID/items",
  });
  await s.fire.fire(loop.id, "f1");
  for (const turn of s.turns) {
    assert.ok(!turn.text?.includes("$LOOP_ID"), `${stage(turn)} still carries the unresolved placeholder`);
  }
  const intake = s.turns.find((t) => stage(t) === "intake");
  assert.match(intake!.text!, new RegExp(`/v1/loops/${loop.id}/items`));
});

test("intake and judge are read-only while work is isolated from surface actions", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const judge = s.turns.find((t) => stage(t) === "judge");
  const work = s.turns.find((t) => stage(t) === "work");
  const intake = s.turns.find((t) => stage(t) === "intake");
  assert.equal(intake?.readOnly, true);
  assert.equal(judge?.readOnly, true);
  assert.notEqual(work?.readOnly, true);
  assert.notEqual(work?.surfaceTools, true);
  assert.notEqual(work?.addressed, true);
  assert.deepEqual(judge?.conversation, work?.conversation);
});

test("shipping a held output runs a ship turn and settles the item", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  const fired = await s.fire.fire(loop.id, "f1");
  const outputId = fired.summary!.ready[0]!;
  const outputs = await s.outputs.awaitingReview(loop.id);
  const shipped = await s.fire.shipOutput(loop.id, outputs[0]!.id, "josh");
  assert.equal(shipped?.state, "shipped");
  assert.equal(shipped?.decidedBy, "josh");
  assert.equal((await s.items.get(shipped!.itemId))?.status, "shipped");
  assert.equal(s.turns.filter((t) => stage(t) === "ship").length, 1);
  assert.equal(s.turns.find((t) => stage(t) === "ship")?.readOnly, undefined);
  assert.ok(outputId);
});

test("a ready output cannot ship unless its ready parent publishes it", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  const { item } = await s.items.enqueue({ loopId: loop.id, sourceKey: "stale" });
  const output = await s.outputs.capture({
    loopId: loop.id,
    itemId: item.id,
    attemptId: "stale-attempt",
    shipAction: "open_pr",
    title: "stale output",
    capturedBy: "ledger",
  });
  await s.outputs.promoteAttempt(item.id, "stale-attempt");
  assert.equal(await s.fire.shipOutput(loop.id, output.id, "josh"), null);
  assert.equal((await s.outputs.get(output.id))?.state, "ready");
  assert.equal(s.turns.length, 0);
});

test("returning a held output re-queues the item carrying the note, and the next fire re-works it", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  const returned = await s.fire.returnOutput(loop.id, output.id, "josh", "wrong module");
  assert.equal(returned?.state, "returned");
  const item = await s.items.get(returned!.itemId);
  assert.equal(item?.status, "queued");
  assert.equal(item?.guidance, "wrong module");
  await s.fire.fire(loop.id, "f2");
  const workPrompts = s.turns.filter((t) => stage(t) === "work").map((t) => t.text ?? "");
  assert.equal(workPrompts.length, 2);
  assert.match(workPrompts[1]!, /wrong module/);
});

test("a replayed ship operation becomes unconfirmed and a person can resolve it either way", async () => {
  for (const decision of ["shipped", "returned"] as const) {
    const s = service(HAPPY);
    const loop = await makeLoop(s.loops);
    await s.fire.fire(loop.id, `fire-${decision}`);
    const output = (await s.outputs.awaitingReview(loop.id))[0]!;
    await s.idempotency.once(`loop:${loop.id}:ship:${output.id}`, async () => {});
    const uncertain = await s.fire.shipOutput(loop.id, output.id, "josh");
    assert.equal(uncertain?.state, "unconfirmed");
    assert.equal((await s.items.get(output.itemId))?.status, "ready");
    const resolved =
      decision === "shipped"
        ? await s.fire.shipOutput(loop.id, output.id, "josh", "confirmed externally")
        : await s.fire.returnOutput(loop.id, output.id, "josh", "retry safely");
    assert.equal(resolved?.state, decision);
  }
});

test("returning one output supersedes active siblings before requeueing the item", async () => {
  const two: Responder = (req) =>
    stage(req) === "work"
      ? '```json\n{"outputs": [{"shipAction": "open_pr", "title": "one", "externalRef": "1"}, {"shipAction": "open_pr", "title": "two", "externalRef": "2"}]}\n```'
      : HAPPY(req);
  const s = service(two);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const outputs = await s.outputs.awaitingReview(loop.id);
  await s.fire.returnOutput(loop.id, outputs[0]!.id, "josh", "redo all");
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
  assert.equal((await s.outputs.get(outputs[1]!.id))?.state, "superseded");
  assert.equal((await s.items.get(outputs[0]!.itemId))?.status, "queued");
});

test("an item decision lease serializes shipping and returning", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  const token = await s.items.acquireDecision(output.itemId);
  assert.ok(token);
  assert.equal(await s.fire.returnOutput(loop.id, output.id, "josh", "retry"), null);
  assert.equal((await s.items.get(output.itemId))?.status, "ready");
  assert.equal(await s.items.releaseDecision(output.itemId, token), true);
  assert.equal((await s.fire.returnOutput(loop.id, output.id, "josh", "retry"))?.state, "returned");
});

test("confirming an unconfirmed output requires its ready parent to publish it", async () => {
  for (const invalid of ["parent", "membership"] as const) {
    const s = service(HAPPY);
    const loop = await makeLoop(s.loops);
    const { item } = await s.items.enqueue({ loopId: loop.id, sourceKey: invalid });
    const claimedItem = await s.items.claim(item.id);
    const output = await s.outputs.capture({
      loopId: loop.id,
      itemId: item.id,
      attemptId: invalid,
      shipAction: "open_pr",
      title: invalid,
      capturedBy: "ledger",
    });
    if (invalid === "membership") await s.items.markReady(item.id, [], claimedItem!.claimToken!);
    await s.outputs.promoteAttempt(item.id, invalid);
    const claimedOutput = await s.outputs.claimShipping(output.id);
    await s.outputs.markUnconfirmed(output.id, claimedOutput!.claimToken!);
    assert.equal(await s.fire.shipOutput(loop.id, output.id, "josh", "confirmed"), null);
    assert.equal((await s.outputs.get(output.id))?.state, "unconfirmed");
  }
});

test("returning an output fails while a sibling is shipping", async () => {
  const two: Responder = (req) =>
    stage(req) === "work"
      ? '```json\n{"outputs": [{"shipAction": "open_pr", "title": "one", "externalRef": "1"}, {"shipAction": "open_pr", "title": "two", "externalRef": "2"}]}\n```'
      : HAPPY(req);
  const s = service(two);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const outputs = await s.outputs.awaitingReview(loop.id);
  await s.outputs.claimShipping(outputs[1]!.id);
  assert.equal(await s.fire.returnOutput(loop.id, outputs[0]!.id, "josh", "retry"), null);
  assert.equal((await s.items.get(outputs[0]!.itemId))?.status, "ready");
  assert.equal((await s.outputs.get(outputs[0]!.id))?.state, "ready");
});

test("redelivering a committed fire key is silent and does not record another failure", async () => {
  const s = service(() => {
    throw new Error("source down");
  });
  const loop = await makeLoop(s.loops);
  await s.idempotency.once("duplicate:intake", async () => {});
  const result = await s.fire.fire(loop.id, "duplicate");
  assert.deepEqual(result, { status: "silent", note: "duplicate fire key" });
  assert.equal((await s.loops.get(loop.id))?.consecutiveFailedFires, undefined);
});

test("a concurrent duplicate intake is silent and does not record a failed fire", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = s.idempotency.once("concurrent:intake", async () => blocked);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const duplicate = await s.fire.fire(loop.id, "concurrent");
  release();
  await owner;
  assert.deepEqual(duplicate, { status: "silent", note: "duplicate fire key" });
  assert.equal((await s.loops.get(loop.id))?.consecutiveFailedFires, undefined);
});

test("the scheduler sweep pings a stale loop without waiting for another fire", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    governor: { staleFireMs: 1_000 },
    destination: { type: "slack", target: "C1", audienceScopeId: base.ownerScopeId },
  });
  await s.loops.recordFireOutcome(loop.id, false);
  const firedAt = (await s.loops.get(loop.id))!.lastFiredAt!;
  await s.fire.sweepStale(firedAt + 1_001);
  assert.equal(s.deliveries.sent.length, 1);
  assert.match(s.deliveries.sent[0]!.text, /trigger looks dead/);
});

test("the scheduler sweep detects a stale loop that has never fired", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    governor: { staleFireMs: 1_000 },
    destination: { type: "slack", target: "C1", audienceScopeId: base.ownerScopeId },
  });
  await s.fire.sweepStale(loop.createdAt + 1_001);
  assert.equal(s.deliveries.sent.length, 1);
  assert.match(s.deliveries.sent[0]!.text, /trigger looks dead/);
});

test("review saturation pings once and recovers after outputs drain", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    caps: { maxOpenOutputs: 1 },
    destination: { type: "slack", target: "C1", audienceScopeId: base.ownerScopeId },
  });
  await s.fire.fire(loop.id, "f1");
  assert.equal((await s.loops.get(loop.id))?.health, "degraded");
  assert.equal(s.deliveries.sent.length, 1);
  assert.match(s.deliveries.sent[0]!.text, /waiting for review/);
  await s.fire.fire(loop.id, "saturated");
  assert.equal(s.deliveries.sent.length, 1);
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  await s.fire.shipOutput(loop.id, output.id, "reviewer");
  await s.fire.fire(loop.id, "drained");
  assert.equal((await s.loops.get(loop.id))?.health, "healthy");
  assert.equal(s.deliveries.sent.length, 1);
});

test("prompt fences cannot be escaped by loop, item, output, or reviewer text", async () => {
  const poison = "before```after";
  const malicious: Responder = (req) => {
    switch (stage(req)) {
      case "intake":
        return `[{"sourceKey":"${poison}","sourceSummary":"${poison}"}]`;
      case "work":
        return `\`\`\`json\n${JSON.stringify({ outputs: [{ shipAction: "open_pr", title: poison, externalRef: poison }] })}\n\`\`\``;
      case "judge":
        return `\`\`\`json\n${JSON.stringify({ outcome: "met", reason: "done", checks: [{ command: poison, passed: true, detail: "ok" }] })}\n\`\`\``;
      default:
        return "done";
    }
  };
  const s = service(malicious);
  const loop = await makeLoop(s.loops, {
    name: poison,
    playbook: poison,
    successCondition: poison,
    successChecks: [poison],
  });
  await s.fire.fire(loop.id, "fence-test");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  await s.fire.shipOutput(loop.id, output.id, "josh", poison);
  for (const turn of s.turns) {
    assert.doesNotMatch(turn.text ?? "", /before```after/);
  }
  const judge = s.turns.find((turn) => stage(turn) === "judge")?.text ?? "";
  assert.doesNotMatch(judge.split("```untrusted-data")[0]!, /sourceKey/);
  assert.match(judge, /"sourceKey":"beforeʼʼʼafter"/);
});

test("an auto grant ships the matching slice without a person", async () => {
  const grants = createShipGrantStore();
  const s = service(HAPPY, { grants });
  const loop = await makeLoop(s.loops);
  await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped.length, 1);
  assert.equal(s.turns.filter((t) => stage(t) === "ship").length, 1);
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
});

test("revoking an auto grant during work leaves the output held", async () => {
  const grants = createShipGrantStore();
  let grantId = "";
  const s = service(
    (req) => {
      if (stage(req) === "judge") void grants.revoke(grantId, "reviewer");
      return HAPPY(req);
    },
    { grants },
  );
  const loop = await makeLoop(s.loops);
  const grant = await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  grantId = grant.id;
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped, []);
  assert.equal(result.summary?.ready.length, 1);
  assert.equal(s.turns.filter((turn) => stage(turn) === "ship").length, 0);
});

test("a policy version bump during work leaves the output held", async () => {
  const grants = createShipGrantStore();
  let loopId = "";
  const s = service(
    (req) => {
      if (stage(req) === "judge") void s.loops.editPlaybook(loopId, { playbook: "new policy", by: "reviewer" });
      return HAPPY(req);
    },
    { grants },
  );
  const loop = await makeLoop(s.loops);
  loopId = loop.id;
  await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped, []);
  assert.equal(result.summary?.ready.length, 1);
  assert.equal(s.turns.filter((turn) => stage(turn) === "ship").length, 0);
});

test("a stale grant does not auto-ship after a semantic policy change", async () => {
  const grants = createShipGrantStore();
  const s = service(HAPPY, { grants });
  const loop = await makeLoop(s.loops);
  await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  await s.loops.editPlaybook(loop.id, { playbook: "triage without side effects", by: "josh" });
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped, []);
  assert.equal(result.summary?.ready.length, 1);
  assert.equal(s.turns.filter((t) => stage(t) === "ship").length, 0);
});

test("an undeclared ship action parks the item and quarantines through the governor", async () => {
  const rogue: Responder = (req) => {
    switch (stage(req)) {
      case "intake":
        return '[{"sourceKey": "SENTRY-9"}]';
      case "work":
        return '```json\n{"outputs": [{"shipAction": "send_email", "title": "Emailed the customer"}]}\n```';
      default:
        return '```json\n{"outcome": "met", "reason": "n/a"}\n```';
    }
  };
  const s = service(rogue);
  const loop = await makeLoop(s.loops);
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.undeclaredShipActions, ["send_email"]);
  const after = await s.loops.get(loop.id);
  assert.equal(after?.state, "quarantined");
  assert.equal(after?.health, "quarantined");
});

test("a failed intake records the failure and repeated failures degrade health", async () => {
  let calls = 0;
  const s = service(() => {
    calls += 1;
    throw new Error("source down");
  });
  const loop = await makeLoop(s.loops);
  for (let i = 0; i < 3; i++) {
    const result = await s.fire.fire(loop.id, `f${i}`);
    assert.equal(result.status, "failed");
  }
  const after = await s.loops.get(loop.id);
  assert.equal(after?.consecutiveFailedFires, 3);
  assert.notEqual(after?.health, "healthy");
  assert.ok(calls >= 3);
});

test("a quiet fire with nothing to review reports silent", async () => {
  const quiet: Responder = (req) => (stage(req) === "intake" ? "```json\n[]\n```" : "done");
  const s = service(quiet);
  const loop = await makeLoop(s.loops);
  const result = await s.fire.fire(loop.id, "f1");
  assert.equal(result.status, "silent");
});

test("an unmet judgment continues the item; the attempt cap parks it", async () => {
  const never: Responder = (req) => {
    switch (stage(req)) {
      case "intake":
        return '[{"sourceKey": "SENTRY-2"}]';
      case "work":
        return '```json\n{"outputs": []}\n```';
      case "judge":
        return '```json\n{"outcome": "continue", "reason": "no PR yet"}\n```';
      default:
        return "done";
    }
  };
  const s = service(never);
  const loop = await makeLoop(s.loops, { caps: { maxItemAttempts: 2 } });
  const first = await s.fire.fire(loop.id, "f1");
  assert.equal(first.summary?.continued.length, 1);
  const second = await s.fire.fire(loop.id, "f2");
  assert.equal(second.summary?.parked.length, 1);
  const items = await s.items.byLoop(loop.id);
  assert.equal(items[0]?.status, "failed");
  assert.match(items[0]?.parkedReason ?? "", /attempt cap/);
});

test("a paused loop refuses to fire", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.loops.setState(loop.id, "paused");
  const result = await s.fire.fire(loop.id, "f1");
  assert.equal(result.status, "silent");
  assert.equal(s.turns.length, 0);
});
