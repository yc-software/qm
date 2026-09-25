import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { buildShipGrant, decideShip, graduationAllowed, undeclaredShipActions } from "../src/loops/ship-gate.ts";
import { scopeId, type Loop } from "../src/types.ts";

const base = {
  owner: "U1",
  createdBy: "U1",
  ownerScopeId: scopeId("personal", "U1"),
  name: "Sentry triage",
  playbook: "fix the issue",
  successCondition: "a PR is linked and CI is green",
};

async function loopWith(shipActions: Loop["shipActions"]): Promise<Loop> {
  return createLoopStore()
    .create({ ...base, shipActions })
    .then(({ loop }) => loop);
}

test("a declared ship action is held for a person by default", async () => {
  const loop = await loopWith([{ action: "open_pr", gate: "hold" }]);
  assert.deepEqual(decideShip(loop, { shipAction: "open_pr" }), { outcome: "hold" });
});

test("an action the playbook never declared is neither held nor shipped — it is undeclared", async () => {
  const loop = await loopWith([{ action: "open_pr", gate: "hold" }]);
  assert.deepEqual(decideShip(loop, { shipAction: "send_email" }), { outcome: "undeclared" });
  assert.deepEqual(undeclaredShipActions(loop, [{ shipAction: "open_pr" }, { shipAction: "send_email" }]), [
    "send_email",
  ]);
});

test("a policy set to auto ships without a grant", async () => {
  const loop = await loopWith([{ action: "open_pr", gate: "auto" }]);
  assert.deepEqual(decideShip(loop, { shipAction: "open_pr" }), { outcome: "auto", via: "policy" });
});

test("a standing grant graduates one labelled slice and leaves the rest held", async () => {
  const loop = await loopWith([{ action: "open_pr", gate: "hold" }]);
  const grant = buildShipGrant({
    loopId: loop.id,
    shipAction: "open_pr",
    label: "lint-fix",
    actorId: "U1",
    policyVersion: loop.policyVersion,
  });
  assert.deepEqual(decideShip(loop, { shipAction: "open_pr", label: "lint-fix" }, [grant]), {
    outcome: "auto",
    via: "grant",
    grantId: grant.id,
  });
  assert.deepEqual(decideShip(loop, { shipAction: "open_pr", label: "schema-migration" }, [grant]), {
    outcome: "hold",
  });
});

test("an unlabelled grant covers every label of that action", async () => {
  const loop = await loopWith([{ action: "front_reply", gate: "hold" }]);
  const grant = buildShipGrant({
    loopId: loop.id,
    shipAction: "front_reply",
    actorId: "U1",
    policyVersion: loop.policyVersion,
  });
  assert.equal(decideShip(loop, { shipAction: "front_reply", label: "refund" }, [grant]).outcome, "auto");
  assert.equal(decideShip(loop, { shipAction: "front_reply" }, [grant]).outcome, "auto");
});

test("a grant for another loop never leaks across loops", async () => {
  const loop = await loopWith([{ action: "open_pr", gate: "hold" }]);
  const foreign = buildShipGrant({
    loopId: "other-loop",
    shipAction: "open_pr",
    actorId: "U1",
    policyVersion: loop.policyVersion,
  });
  assert.deepEqual(decideShip(loop, { shipAction: "open_pr" }, [foreign]), { outcome: "hold" });
});

test("an org that disables always-grants disables ship-gate graduation the same way", async () => {
  const loop = await loopWith([{ action: "open_pr", gate: "hold" }]);
  assert.equal(graduationAllowed({ session: true, always: false }), false);
  assert.throws(
    () =>
      buildShipGrant({
        loopId: loop.id,
        shipAction: "open_pr",
        actorId: "U1",
        policyVersion: loop.policyVersion,
        modes: { session: true, always: false },
      }),
    /disabled/,
  );
});

test("ship actions are declared once — a repeated declaration does not stack", async () => {
  const loop = await loopWith([
    { action: "open_pr", gate: "hold" },
    { action: "open_pr", gate: "auto" },
  ]);
  assert.deepEqual(loop.shipActions, [{ action: "open_pr", gate: "auto" }]);
});
