import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalStore } from "../src/core/approval-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { PendingApprovalRecord } from "../src/types.ts";

function record(threadRef: string, createdAt = 1): PendingApprovalRecord {
  return {
    sessionId: threadRef,
    command: "publish",
    createdAt,
    request: {
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "publish report",
    },
    kind: "input",
    grantModes: { session: false, always: false },
  };
}

for (const threadRef of ["dm:D1", "agent:main:subagent:child"]) {
  test(`saving approval immediately delivers a native request for ${threadRef}`, async () => {
    const backing = createMemoryMap<PendingApprovalRecord>();
    const deliveries = createDeliveryStore();
    const approvals = createApprovalStore(backing, deliveries);
    await approvals.put("A1", record(threadRef));
    const [delivery] = await deliveries.pending("principal");
    assert.equal(delivery?.destination.commandApprovalId, "A1");
    assert.equal(delivery?.destination.target, "U1");
    assert.deepEqual((await backing.get("A1"))?.grantModes, { session: false, always: false });
    await approvals.deliverPending();
    assert.equal((await deliveries.pending("principal")).length, 1);
    await deliveries.ack(delivery!.id, Date.now());
    await approvals.take("A1");
    await approvals.put("A1", record(threadRef, 2));
    assert.equal((await deliveries.pending("principal")).length, 1);
    assert.notEqual((await deliveries.pending("principal"))[0]!.id, delivery!.id);
  });
}

test("persisted approvals recover after enqueue failure and restart without failing the turn", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const failed = createApprovalStore(backing, {
    enqueue: async () => {
      throw new Error("delivery unavailable");
    },
  });
  await failed.put("A1", record("agent:main:subagent:child"));
  assert.ok(await backing.get("A1"));
  const deliveries = createDeliveryStore();
  const restarted = createApprovalStore(backing, deliveries);
  await restarted.deliverPending();
  await restarted.deliverPending();
  assert.equal((await deliveries.pending("principal")).length, 1);
});

test("web approvals remain on their native surface", async () => {
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(createMemoryMap<PendingApprovalRecord>(), deliveries);
  const approval = record("web:U1");
  approval.request!.surface = "web";
  await approvals.put("A1", approval);
  await approvals.deliverPending();
  assert.equal((await deliveries.pending("principal")).length, 0);
});
