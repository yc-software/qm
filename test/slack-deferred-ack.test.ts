import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeferredEnvelopeAck } from "../src/slack/deferred-ack.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("gated envelope: the real ack fires only AFTER the fake core has durably queued the turn", async () => {
  const events: string[] = [];
  const { ack, gate } = createDeferredEnvelopeAck(
    async () => {
      events.push("socket-ack");
    },
    { gated: true, capMs: 5_000 },
  );

  const fakeCoreEnqueue = async (): Promise<void> => {
    await tick(20);
    events.push("core-persisted");
  };

  await ack();
  assert.deepEqual(events, []);

  await fakeCoreEnqueue();
  gate.persisted();
  await tick(0);
  assert.deepEqual(events, ["core-persisted", "socket-ack"]);
});

test("gated envelope: repeated persisted/ack calls ack the socket exactly once", async () => {
  let acks = 0;
  const { ack, gate } = createDeferredEnvelopeAck(
    async () => {
      acks += 1;
    },
    { gated: true, capMs: 5_000 },
  );
  await ack();
  gate.persisted();
  gate.persisted();
  await ack();
  await tick(0);
  assert.equal(acks, 1);
});

test("gated envelope: the cap acks anyway so Slack's deadline can't drop the socket", async () => {
  let acks = 0;
  const { ack } = createDeferredEnvelopeAck(
    async () => {
      acks += 1;
    },
    { gated: true, capMs: 15 },
  );
  await ack();
  assert.equal(acks, 0);
  await tick(40);
  assert.equal(acks, 1);
});

test("gated envelope: a failure before persistence withholds the ack entirely (Slack redelivers)", async () => {
  let acks = 0;
  const { ack, gate } = createDeferredEnvelopeAck(
    async () => {
      acks += 1;
    },
    { gated: true, capMs: 15 },
  );
  await ack();
  gate.failed("core unreachable");
  await tick(40);
  gate.persisted();
  await tick(0);
  assert.equal(acks, 0);
});

test("ungated envelope acks immediately when Bolt asks", async () => {
  let acks = 0;
  const { ack } = createDeferredEnvelopeAck(
    async () => {
      acks += 1;
    },
    { gated: false },
  );
  await ack();
  await tick(0);
  assert.equal(acks, 1);
});
