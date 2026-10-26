import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalStore } from "../src/core/approval-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { recordingOutbound } from "./support/recording-outbound.ts";
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
    const outbound = recordingOutbound();
    const approvals = createApprovalStore(backing, outbound);
    await approvals.put("A1", record(threadRef));
    const [delivery] = await outbound.pending("principal");
    assert.equal(delivery?.destination.commandApprovalId, "A1");
    assert.equal(delivery?.destination.target, "U1");
    assert.deepEqual((await backing.get("A1"))?.grantModes, { session: false, always: false });
    await approvals.deliverPending();
    assert.equal((await outbound.pending("principal")).length, 1, "the sweep does not repeat a posted request");
    await approvals.take("A1");
    await approvals.put("A1", record(threadRef, 2));
    const posts = await outbound.pending("principal");
    assert.equal(posts.length, 2, "a new request for the same id is posted again");
    assert.notEqual(posts[1]!.idempotencyKey, delivery!.idempotencyKey);
  });
}

test("persisted approvals recover after a failed post and restart without failing the turn", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const failed = createApprovalStore(backing, {
    send: async () => {
      throw new Error("delivery unavailable");
    },
  });
  await failed.put("A1", record("agent:main:subagent:child"));
  assert.ok(await backing.get("A1"));
  const outbound = recordingOutbound();
  const restarted = createApprovalStore(backing, outbound);
  await restarted.deliverPending();
  await restarted.deliverPending();
  assert.equal((await outbound.pending("principal")).length, 1);
});

test("web approvals remain on their native surface", async () => {
  const outbound = recordingOutbound();
  const approvals = createApprovalStore(createMemoryMap<PendingApprovalRecord>(), outbound);
  const approval = record("web:U1");
  approval.request!.surface = "web";
  await approvals.put("A1", approval);
  await approvals.deliverPending();
  assert.equal((await outbound.pending("principal")).length, 0);
});

test("system approvals stay pending without posting an impossible Slack DM", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const outbound = recordingOutbound();
  const approvals = createApprovalStore(backing, outbound);
  const approval = record("slack:C1:ambient:1.0");
  approval.request!.actor.externalId = "system:ambient:acme";

  await approvals.put("A1", approval);
  await approvals.put("A2", approval);
  await approvals.deliverPending();
  await createApprovalStore(backing, outbound).deliverPending();

  assert.deepEqual(await backing.get("A1"), approval, "the protected action still requires approval");
  assert.deepEqual(await backing.get("A2"), approval);
  assert.deepEqual(await outbound.pending("principal"), []);
});

test("approvals requested from a Slack DM thread are delivered into that thread", async () => {
  for (const threadRef of ["dm:D1:1700.1", "agent:main:subagent:child"]) {
    const outbound = recordingOutbound();
    const approvals = createApprovalStore(createMemoryMap<PendingApprovalRecord>(), outbound);
    const approval = record(threadRef);
    approval.request!.slackSource = { accountId: "default", teamId: "T1", userId: "U1", replyThreadTs: "1700.1" };
    await approvals.put("A1", approval);
    const [delivery] = await outbound.pending("principal");
    assert.equal(delivery?.destination.threadTs, "1700.1");
  }
  const outbound = recordingOutbound();
  const approvals = createApprovalStore(createMemoryMap<PendingApprovalRecord>(), outbound);
  const channel = record("channel:C1:1700.2");
  channel.request!.conversation = { kind: "channel", threadRef: "channel:C1:1700.2" } as never;
  channel.request!.slackSource = { accountId: "default", teamId: "T1", userId: "U1", replyThreadTs: "1700.2" };
  await approvals.put("A2", channel);
  assert.equal((await outbound.pending("principal"))[0]?.destination.threadTs, undefined);
});
