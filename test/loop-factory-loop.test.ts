import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { ensureFactoryLoop, findFactoryLoop } from "../src/loops/factory/factory-loop.ts";
import { ensureInboxLoop } from "../src/loops/inbox-loop.ts";
import { FACTORY_LOOP_SURFACE } from "../src/loops/factory/effects.ts";
import { decideShip, undeclaredShipActions } from "../src/loops/ship-gate.ts";
import { scopeId } from "../src/types.ts";

const ORG = scopeId("org", "default-org");

test("findFactoryLoop matches on the factory surface and the org scope, and nothing else", async () => {
  const store = createLoopStore();
  assert.equal(await findFactoryLoop(store, ORG), null);

  await ensureInboxLoop(store, "josh");
  assert.equal(await findFactoryLoop(store, ORG), null);

  const personal = await ensureFactoryLoop(store, { owner: "josh", orgScopeId: scopeId("personal", "josh") });
  assert.equal(personal.surface, FACTORY_LOOP_SURFACE);
  assert.equal(await findFactoryLoop(store, ORG), null);
  assert.equal((await findFactoryLoop(store, scopeId("personal", "josh")))?.id, personal.id);
});

test("ensureFactoryLoop mints one org-scoped factory loop the human admin can administer", async () => {
  const store = createLoopStore();
  const loop = await ensureFactoryLoop(store, { owner: "admin-alice", orgScopeId: ORG });

  assert.equal(loop.surface, FACTORY_LOOP_SURFACE);
  assert.equal(loop.ownerScopeId, ORG);
  assert.equal(loop.owner, "admin-alice");
  assert.equal(loop.createdBy, "admin-alice");
  assert.equal(loop.name, "Software factory");
  assert.deepEqual(loop.shipActions, [
    { action: "open_pr", gate: "auto" },
    { action: "close_already_fixed", gate: "auto" },
  ]);
  assert.equal(loop.runAs, undefined);
  assert.equal(loop.sources, undefined);
  assert.equal(loop.cronId, undefined);
  assert.equal(loop.state, "enabled");
  assert.ok((loop.purpose ?? "").trim().length > 0);
  assert.ok(loop.playbook.trim().length > 0);
  assert.ok(loop.successCondition.trim().length > 0);

  assert.equal((await findFactoryLoop(store, ORG))?.id, loop.id);
});

test("ensureFactoryLoop is idempotent across repeat calls, other admins, and concurrent applies", async () => {
  const store = createLoopStore();
  const first = await ensureFactoryLoop(store, { owner: "admin-alice", orgScopeId: ORG });

  const again = await ensureFactoryLoop(store, { owner: "admin-alice", orgScopeId: ORG });
  assert.equal(again.id, first.id);
  assert.equal((await store.list()).length, 1);

  const byBob = await ensureFactoryLoop(store, { owner: "admin-bob", orgScopeId: ORG });
  assert.equal(byBob.id, first.id);
  assert.equal(byBob.owner, "admin-alice");
  assert.equal((await store.list()).length, 1);

  const raced = await Promise.all([
    ensureFactoryLoop(store, { owner: "admin-alice", orgScopeId: ORG }),
    ensureFactoryLoop(store, { owner: "admin-alice", orgScopeId: ORG }),
  ]);
  assert.equal((await store.list()).length, 1);
  for (const loop of raced) assert.equal(loop.surface, FACTORY_LOOP_SURFACE);
});

test("the factory's declared ship actions are the ones its outputs carry, and both ship without a grant", async () => {
  const store = createLoopStore();
  const loop = await ensureFactoryLoop(store, { owner: "admin-alice", orgScopeId: ORG });

  assert.deepEqual(undeclaredShipActions(loop, [{ shipAction: "open_pr" }, { shipAction: "close_already_fixed" }]), []);

  // No human sits between a converged run and its pull request: the policy itself ships, no grant needed.
  for (const shipAction of ["open_pr", "close_already_fixed"]) {
    assert.deepEqual(decideShip(loop, { shipAction }), { outcome: "auto", via: "policy" }, shipAction);
  }
});
