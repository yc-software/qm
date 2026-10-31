import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnvelopeStaging, envelopeKey, type StagedEnvelope } from "../src/slack/envelope-staging.ts";
import { createDeferredEnvelopeAck, envelopeStageFor } from "../src/slack/deferred-ack.ts";
import { TEST_TENANT } from "./support/tenant.ts";
import { testMap } from "./support/test-database.ts";
import { settle } from "./support/settle.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function staged(read: () => Promise<unknown>): Promise<void> {
  await settle(async () => (await read()) !== null);
}

async function cleared(read: () => Promise<unknown>): Promise<unknown> {
  await settle(async () => (await read()) === null);
  return read();
}

function envelope(type: string, ts: string, channel = "C1"): Record<string, unknown> {
  return { type: "event_callback", event: { type, channel, ts, text: "hi" } };
}

test("the staging key is scoped by account, event type, channel and ts, and ignores non-event envelopes", () => {
  assert.equal(envelopeKey("acct", envelope("message", "1.0")), "slack:acct:message:C1:1.0");
  assert.equal(envelopeKey("acct", envelope("app_mention", "1.0")), "slack:acct:app_mention:C1:1.0");
  assert.equal(envelopeKey("other", envelope("message", "1.0")), "slack:other:message:C1:1.0");
  assert.equal(envelopeKey("acct", { type: "url_verification" }), null);
});

test("staging lands within its budget, or reports that it did not", async () => {
  const map = testMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  assert.equal(await staging.stage("k1", envelope("message", "1.0")), true);
  assert.ok(await map.get("k1"));
  const slow = createEnvelopeStaging({ ...map, putIfAbsent: () => new Promise(() => {}) } as typeof map, {
    account: "acct",
    stageTimeoutMs: 20,
  });
  assert.equal(await slow.stage("k2", envelope("message", "2.0")), false);
});

test("a replay whose handler durably accepts clears the row through accepted()", async () => {
  const map = testMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  await staging.stage("k", envelope("message", "1.0"));
  staging.accepted("k");
  await tick(0);
  assert.equal(await cleared(() => map.get("k")), null);
});

test("gate: when the cap fires first, the envelope is staged before the ack; later acceptance clears it", async () => {
  const map = testMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  const body = envelope("message", "1.0");
  const events: string[] = [];
  const { ack, gate } = createDeferredEnvelopeAck(
    async () => {
      events.push("ack");
    },
    { gated: true, capMs: 10, ...envelopeStageFor(staging, body) },
  );
  await ack();
  await staged(() => map.get("slack:acct:message:C1:1.0"));
  await settle(async () => events.length > 0);
  assert.deepEqual(events, ["ack"]);
  assert.ok(await map.get("slack:acct:message:C1:1.0"), "the row exists while acceptance is unknown");
  gate.persisted();
  await tick(0);
  assert.equal(
    await cleared(() => map.get("slack:acct:message:C1:1.0")),
    null,
    "durable acceptance clears the staged row",
  );
});

test("gate: when staging cannot land before the cap, the ack is withheld so Slack redelivers", async () => {
  const map = testMap<StagedEnvelope>();
  const slow = createEnvelopeStaging({ ...map, putIfAbsent: () => new Promise(() => {}) } as typeof map, {
    account: "acct",
    stageTimeoutMs: 10,
  });
  const body = envelope("message", "1.0");
  let acks = 0;
  let withheld = 0;
  const { ack } = createDeferredEnvelopeAck(
    async () => {
      acks++;
    },
    { gated: true, capMs: 10, onWithhold: () => withheld++, ...envelopeStageFor(slow, body) },
  );
  await ack();
  await tick(60);
  assert.equal(acks, 0);
  assert.equal(withheld, 1);
});

test("gate: a handler failure after the cap leaves the staged row for the sweeper", async () => {
  const map = testMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  const body = envelope("message", "1.0");
  const { ack, gate } = createDeferredEnvelopeAck(async () => {}, {
    gated: true,
    capMs: 10,
    ...envelopeStageFor(staging, body),
  });
  await ack();
  await staged(() => map.get("slack:acct:message:C1:1.0"));
  gate.failed("boom");
  await tick(0);
  assert.ok(await map.get("slack:acct:message:C1:1.0"), "the message the ack already covered is still recoverable");
});

test("a replay clears its row when the handler settles or accepts, keeps it while running, and keeps it on failure", async () => {
  const map = testMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct", replayWaitMs: 20 });
  const rows = [
    ["settled", "1.0"],
    ["running", "2.0"],
    ["accepted", "3.0"],
    ["failed", "4.0"],
    ["late", "5.0"],
  ] as const;
  for (const [key, ts] of rows) await staging.stage(key, envelope("message", ts));
  let releaseLate: (() => void) | undefined;
  await Promise.all(
    rows.map(([key, ts]) =>
      staging.replay(
        { tenantId: TEST_TENANT, key, body: envelope("message", ts), account: "acct", attempts: 1 },
        (body, gate) => {
          const replayed = (body.event as { ts: string }).ts;
          if (replayed === "2.0") return new Promise(() => {});
          if (replayed === "3.0") gate.persisted();
          if (replayed === "4.0") gate.failed("boom");
          if (replayed === "5.0") return new Promise((r) => (releaseLate = () => r()));
          return Promise.resolve();
        },
      ),
    ),
  );
  await tick(0);
  assert.equal(
    await cleared(() => map.get("settled")),
    null,
    "a settled replay (even a silent one) is done with the row",
  );
  assert.equal(await cleared(() => map.get("accepted")), null, "durable acceptance clears the row");
  assert.ok(await map.get("running"), "an unfinished replay keeps its row until the handler accepts it");
  assert.ok(await map.get("failed"), "a replay whose handler failed keeps its row for the next attempt");
  assert.ok(await map.get("late"), "the replay moved on after its wait");
  releaseLate!();
  await tick(0);
  assert.equal(await cleared(() => map.get("late")), null, "a replay that settles after the wait still clears its row");
});
test("gate: acceptance that lands while the stage write is still in flight still clears the row once it lands", async () => {
  const map = testMap<StagedEnvelope>();
  let release: (() => void) | undefined;
  let landed: Promise<unknown> = Promise.resolve();
  const slowMap: typeof map = {
    ...map,
    putIfAbsent: (key, value) =>
      new Promise((resolve) => {
        release = () => {
          const write = map.putIfAbsent(key, value);
          landed = write;
          resolve(write);
        };
      }),
  };
  const staging = createEnvelopeStaging(slowMap, { account: "acct", stageTimeoutMs: 10 });
  const body = envelope("message", "1.0");
  let acks = 0;
  const { ack, gate } = createDeferredEnvelopeAck(
    async () => {
      acks++;
    },
    { gated: true, capMs: 10, onWithhold: () => {}, ...envelopeStageFor(staging, body) },
  );
  await ack();
  await tick(15);
  gate.persisted();
  await tick(0);
  release!();
  await landed;
  await tick(10);
  assert.equal(acks, 1);
  assert.equal(
    await cleared(() => map.get("slack:acct:message:C1:1.0")),
    null,
    "the late-landing row is cleared, not orphaned",
  );
});

test("gate: a handler failure after the cap keeps the staged row even though the receiver reports completion", async () => {
  const map = testMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  const body = envelope("message", "1.0");
  const { ack, gate } = createDeferredEnvelopeAck(async () => {}, {
    gated: true,
    capMs: 10,
    ...envelopeStageFor(staging, body),
  });
  await ack();
  await staged(() => map.get("slack:acct:message:C1:1.0"));
  gate.failed("boom");
  gate.persisted();
  await tick(0);
  assert.ok(await map.get("slack:acct:message:C1:1.0"), "the row survives the receiver's unconditional persisted()");
});
