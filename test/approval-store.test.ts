import assert from "node:assert/strict";
import test from "node:test";
import { approvalDestination, createApprovalStore } from "../src/core/approval-store.ts";
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

test("system approvals stay pending without enqueuing or reviving an impossible Slack DM", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore({ maxAgeMs: 0 });
  const approvals = createApprovalStore(backing, deliveries);
  const approval = record("slack:C1:ambient:1.0");
  approval.request!.actor.externalId = "system:ambient:acme";
  const stale = await deliveries.enqueue({
    destination: { type: "principal", target: "system:ambient:acme", commandApprovalId: "A1" },
    text: "Approval needed: publish",
    idempotencyKey: "command-approval:A1:1",
  });
  await deliveries.claimPending("principal", 1);
  const expiredAt = (await deliveries.get(stale.id))?.expiredAt;
  assert.ok(expiredAt);

  await approvals.put("A1", approval);
  await approvals.put("A2", approval);
  await approvals.deliverPending();
  await createApprovalStore(backing, deliveries).deliverPending();

  assert.deepEqual(await backing.get("A1"), approval, "the protected action still requires approval");
  assert.deepEqual(await backing.get("A2"), approval);
  assert.deepEqual(await deliveries.pending("principal"), []);
  assert.equal((await deliveries.get(stale.id))?.expiredAt, expiredAt, "a sweep must not revive the stale DM");
});

test("scheduled-task approvals post at the task's own destination, like credential cards", async () => {
  const channel = { type: "slack", target: "C9:100.200", audienceScopeId: "channel:C9" as const };
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(createMemoryMap<PendingApprovalRecord>(), deliveries);
  const toChannel = record("cron:K1");
  toChannel.request!.surface = "cron";
  toChannel.request!.triggerDestination = channel;
  await approvals.put("A1", toChannel);
  const [channelCard] = await deliveries.pending("slack");
  assert.equal(channelCard?.destination.target, "C9:100.200");
  assert.equal(channelCard?.destination.commandApprovalId, "A1");

  const noDestination = record("cron:K2");
  noDestination.request!.surface = "cron";
  await approvals.put("A2", noDestination);
  const ownerCards = await deliveries.pending("principal");
  assert.equal(ownerCards.length, 1, "no destination falls back to the owner's DM");
  assert.equal(ownerCards[0]!.destination.target, "U1");

  const otherPerson = record("cron:K3");
  otherPerson.request!.surface = "cron";
  otherPerson.request!.triggerDestination = { type: "principal", target: "U2", audienceScopeId: "personal:U2" };
  assert.equal(approvalDestination(otherPerson.request!, "U1").target, "U1", "never DMs someone else's card");

  const web = record("cron:K4");
  web.request!.surface = "cron";
  web.request!.triggerDestination = { type: "web", target: "s1" } as never;
  assert.equal(approvalDestination(web.request!, "U1").target, "U1");
});

test("Slack channel approvals post in the requesting thread; DMs stay in the DM", async () => {
  const thread = record("slack:C1:1.0");
  thread.request!.conversation = { kind: "channel", threadRef: "slack:C1:1.0", channelRef: "C1" };
  thread.request!.deliveryTarget = "C1:1.0";
  assert.deepEqual(approvalDestination(thread.request!, "U1"), {
    type: "slack",
    target: "C1:1.0",
    audienceScopeId: "channel:C1",
  });
  const dm = record("dm:D1");
  dm.request!.deliveryTarget = "D1";
  assert.equal(approvalDestination(dm.request!, "U1").type, "principal");
});
