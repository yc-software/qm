import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { collectVitals, evaluateGovernor, healthWorsened, type LoopVitals } from "../src/loops/governor.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { scopeId, type Loop, type LoopCaps, type LoopGovernorConfig } from "../src/types.ts";

const base = {
  owner: "U1",
  createdBy: "U1",
  ownerScopeId: scopeId("personal", "U1"),
  name: "Sentry triage",
  playbook: "fix the issue",
  successCondition: "a PR is linked and CI is green",
  shipActions: [{ action: "open_pr", gate: "hold" as const }],
};

const quiet: LoopVitals = {
  queue: { queued: 0, inProgress: 0, ready: 0, failed: 0 },
  openOutputs: 0,
  decidedOutputs: 0,
  returnedOutputs: 0,
};

async function loop(overrides: { caps?: LoopCaps; governor?: LoopGovernorConfig } = {}): Promise<Loop> {
  return createLoopStore()
    .create({ ...base, ...overrides })
    .then(({ loop }) => loop);
}

const typesOf = (actions: Array<{ type: string }>) => actions.map((a) => a.type);

test("a healthy loop with nothing wrong produces no actions", async () => {
  const verdict = evaluateGovernor(await loop(), quiet, Date.now());
  assert.equal(verdict.health, "healthy");
  assert.deepEqual(verdict.actions, []);
  assert.equal(verdict.escalate, false);
});

test("an undeclared ship action quarantines a loop that set no caps at all", async () => {
  const verdict = evaluateGovernor(await loop(), { ...quiet, undeclaredShipActions: ["send_email"] }, Date.now());
  assert.equal(verdict.health, "quarantined");
  assert.deepEqual(typesOf(verdict.actions), ["quarantine"]);
  assert.match(verdict.reason ?? "", /send_email/);
});

test("consecutive failed fires quarantine by arithmetic alone", async () => {
  const failing = { ...(await loop()), consecutiveFailedFires: 3 };
  const verdict = evaluateGovernor(failing, quiet, Date.now());
  assert.equal(verdict.health, "quarantined");
  assert.deepEqual(typesOf(verdict.actions), ["quarantine"]);
});

test("two failed fires grade the loop failing without stopping it yet", async () => {
  const verdict = evaluateGovernor({ ...(await loop()), consecutiveFailedFires: 2 }, quiet, Date.now());
  assert.equal(verdict.health, "failing");
  assert.deepEqual(verdict.actions, []);
});

test("a high return rate is the loudest signal that the loop is not working", async () => {
  const vitals = { ...quiet, decidedOutputs: 6, returnedOutputs: 5 };
  const verdict = evaluateGovernor(await loop(), vitals, Date.now());
  assert.equal(verdict.health, "failing");
  assert.deepEqual(typesOf(verdict.actions), ["throttle"]);
  assert.match(verdict.actions[0]!.recommendation ?? "", /revise/);
});

test("a couple of early returns are not enough evidence to grade the loop", async () => {
  const verdict = evaluateGovernor(await loop(), { ...quiet, decidedOutputs: 2, returnedOutputs: 2 }, Date.now());
  assert.equal(verdict.health, "healthy");
  assert.deepEqual(verdict.actions, []);
});

test("cap-derived tripwires stay disarmed when the user declined caps", async () => {
  const uncapped = await loop();
  const vitals = { ...quiet, openOutputs: 500 };
  const verdict = evaluateGovernor(uncapped, vitals, Date.now());
  assert.equal(verdict.health, "healthy");
  assert.deepEqual(verdict.actions, []);
});

test("outputs piling up unreviewed degrades health until review drains", async () => {
  const capped = await loop({ caps: { maxOpenOutputs: 10 } });
  const verdict = evaluateGovernor(capped, { ...quiet, openOutputs: 12 }, Date.now());
  assert.equal(verdict.health, "degraded");
  assert.deepEqual(typesOf(verdict.actions), ["ping"]);
  assert.match(verdict.actions[0]!.recommendation ?? "", /throttle intake/);
  const recovered = evaluateGovernor({ ...capped, health: "degraded" }, quiet, Date.now());
  assert.equal(recovered.health, "healthy");
  assert.deepEqual(recovered.actions, []);
});

test("a queue outrunning the work stage asks to throttle", async () => {
  const configured = await loop({ governor: { maxQueueDepth: 5 } });
  const vitals = { ...quiet, queue: { queued: 9, inProgress: 0, ready: 0, failed: 0 } };
  const verdict = evaluateGovernor(configured, vitals, Date.now());
  assert.equal(verdict.health, "degraded");
  assert.deepEqual(typesOf(verdict.actions), ["throttle"]);
  assert.equal(verdict.throttle, true);
});

test("unconfirmed undeclared outputs quarantine the loop", async () => {
  const configured = await loop();
  const items = createLoopItemLedger();
  const outputs = createLoopOutputStore();
  const { item } = await items.enqueue({ loopId: configured.id, sourceKey: "pending" });
  const output = await outputs.capture({
    loopId: configured.id,
    itemId: item.id,
    attemptId: "a1",
    shipAction: "send_email",
    title: "pending email",
    capturedBy: "ledger",
  });
  await outputs.promoteAttempt(item.id, "a1");
  const claimed = await outputs.claimShipping(output.id);
  await outputs.markUnconfirmed(output.id, claimed!.claimToken!);
  const vitals = await collectVitals(configured, { items, outputs }, Date.now());
  assert.deepEqual(vitals.undeclaredShipActions, ["send_email"]);
  assert.equal(evaluateGovernor(configured, vitals, Date.now()).health, "quarantined");
});

test("a trigger that stopped firing is itself detected", async () => {
  const configured = await loop({ governor: { staleFireMs: 60_000 } });
  const now = Date.now();
  const verdict = evaluateGovernor({ ...configured, lastFiredAt: now - 600_000 }, quiet, now);
  assert.equal(verdict.health, "degraded");
  assert.match(verdict.actions[0]!.recommendation ?? "", /trigger looks dead/);
});

test("escalation fires on the change of state, not on every bad fire", async () => {
  const degraded = { ...(await loop()), health: "degraded" as const };
  const vitals = { ...quiet, queue: { queued: 99, inProgress: 0, ready: 0, failed: 0 } };
  const verdict = evaluateGovernor({ ...degraded, governor: { maxQueueDepth: 5 } }, vitals, Date.now());
  assert.equal(verdict.health, "degraded");
  assert.equal(verdict.escalate, false);
  assert.equal(healthWorsened("degraded", "failing"), true);
  assert.equal(healthWorsened("failing", "degraded"), false);
});
