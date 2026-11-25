import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalStore as createRoutedApprovalStore } from "../src/surfaces/approval-store.ts";
import { slackApprovalCardRoute } from "../src/slack/approval-cards.ts";
import { genericChatApprovalCardRoute } from "../src/surfaces/generic-chat/approvals.ts";
import { GENERIC_CHAT } from "../src/surfaces/generic-chat/protocol.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { slackSurfaceOrigin } from "../src/surfaces/slack/adapter.ts";
import type { PendingApprovalRecord } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";
import { personalScope } from "../src/types.ts";

type StoreArgs = Parameters<typeof createRoutedApprovalStore>;
const createApprovalStore = (backing: StoreArgs[0], deliveries: StoreArgs[1]) =>
  createRoutedApprovalStore(backing, deliveries, { slack: slackApprovalCardRoute });

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
    const backing = testMap<PendingApprovalRecord>();
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
  const backing = testMap<PendingApprovalRecord>();
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
  const approvals = createApprovalStore(testMap<PendingApprovalRecord>(), deliveries);
  const approval = record("web:U1");
  approval.request!.surface = "web";
  await approvals.put("A1", approval);
  await approvals.deliverPending();
  assert.equal((await deliveries.pending("principal")).length, 0);
});

test("system approvals stay pending without enqueuing or reviving an impossible Slack DM", async () => {
  const backing = testMap<PendingApprovalRecord>();
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

test("approvals requested from a Slack DM thread are delivered into that thread", async () => {
  for (const threadRef of ["dm:D1:1700.1", "agent:main:subagent:child"]) {
    const deliveries = createDeliveryStore();
    const approvals = createApprovalStore(testMap<PendingApprovalRecord>(), deliveries);
    const approval = record(threadRef);
    approval.request!.surfaceOrigin = slackSurfaceOrigin({
      accountId: "default",
      teamId: "T1",
      userId: "U1",
      replyThreadTs: "1700.1",
    });
    await approvals.put("A1", approval);
    const [delivery] = await deliveries.pending("principal");
    assert.equal(delivery?.destination.threadTs, "1700.1");
  }
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(testMap<PendingApprovalRecord>(), deliveries);
  const channel = record("channel:C1:1700.2");
  channel.request!.conversation = { kind: "channel", threadRef: "channel:C1:1700.2" } as never;
  channel.request!.surfaceOrigin = slackSurfaceOrigin({
    accountId: "partner",
    teamId: "T1",
    userId: "U1",
    replyThreadTs: "1700.2",
  });
  await approvals.put("A2", channel);
  const [delivery] = await deliveries.pending("principal");
  assert.equal(delivery?.destination.threadTs, undefined);
  assert.deepEqual(delivery?.destination.account, { id: "partner", workspace: "T1" });
});

test("a Slack-originated approval goes to the Slack author even when the actor is a linked non-Slack principal", async () => {
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(testMap<PendingApprovalRecord>(), deliveries);
  const approval = record("dm:D1");
  approval.request!.actor.externalId = "oidc:linked-principal";
  approval.request!.surfaceOrigin = slackSurfaceOrigin({ accountId: "default", teamId: "T1", userId: "U9" });
  await approvals.put("A1", approval);
  const [delivery] = await deliveries.pending("principal");
  assert.equal(delivery?.destination.target, "U9");
  assert.equal(delivery?.destination.onBehalfOf, "oidc:linked-principal");
  assert.equal(delivery?.destination.audienceScopeId, personalScope("oidc:linked-principal"));
});

test("automation approvals route through the fallback route and generic-chat destinations", async () => {
  const deliveries = createDeliveryStore();
  const store = createRoutedApprovalStore(
    testMap<PendingApprovalRecord>(),
    deliveries,
    { slack: slackApprovalCardRoute },
    (req) => genericChatApprovalCardRoute(req) ?? slackApprovalCardRoute(req),
  );
  const auto = {
    ...record("cron:c1:1"),
    request: {
      ...record("cron:c1:1").request!,
      surface: "cron",
      origin: { kind: "automation" as const },
    },
  };
  await store.put("a-cron", auto);
  await store.put("a-chat", {
    ...auto,
    request: {
      ...auto.request,
      origin: { kind: "automation" as const, destination: { type: GENERIC_CHAT, target: "acc:room" } },
    },
  });
  assert.deepEqual(
    (await deliveries.pending("principal")).map((d) => [d.destination.commandApprovalId, d.destination.target]),
    [["a-cron", "U1"]],
  );
  assert.deepEqual(
    (await deliveries.pending(GENERIC_CHAT)).map((d) => [d.destination.commandApprovalId, d.destination.target]),
    [["a-chat", "acc:room"]],
  );
});

test("a fire's approval reaches its owner's DM whatever surface the run came from", async () => {
  for (const surface of ["cron", "webhook", "loop", "approval"]) {
    const deliveries = createDeliveryStore();
    const approvals = createApprovalStore(testMap<PendingApprovalRecord>(), deliveries);
    const approval = record(`cron:c1:${surface}`);
    approval.request!.surface = surface;
    approval.request!.actor.externalId = "owner@example.com";
    await approvals.put("A1", approval);
    const [delivery] = await deliveries.pending("principal");
    assert.equal(delivery?.destination.target, "owner@example.com", surface);
    assert.equal(delivery?.destination.commandApprovalId, "A1");
    assert.equal((await approvals.get("A1"))?.cardTo, "owner@example.com");
  }
});
