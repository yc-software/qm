import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createEnvelopeStaging, envelopeKey, type StagedEnvelope } from "../src/slack/envelope-staging.ts";
import { createDeferredEnvelopeAck, envelopeStageFor } from "../src/slack/deferred-ack.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const map = createMemoryMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  assert.equal(await staging.stage("k1", envelope("message", "1.0")), true);
  assert.ok(await map.get("k1"));
  const slow = createEnvelopeStaging({ ...map, putIfAbsent: () => new Promise(() => {}) } as typeof map, {
    account: "acct",
    stageTimeoutMs: 20,
  });
  assert.equal(await slow.stage("k2", envelope("message", "2.0")), false);
});

test("the sweep replays only stale unclaimed rows of its own account, claims them, and gives up on a failing handler after max attempts", async () => {
  const map = createMemoryMap<StagedEnvelope>();
  let now = 1_000_000;
  const staging = createEnvelopeStaging(map, { account: "acct", now: () => now, staleAfterMs: 1_000, maxAttempts: 2 });
  await map.put("other", { body: envelope("message", "2.0"), account: "other", receivedAt: 1, attempts: 0 });
  await staging.stage("stale", envelope("message", "3.0"));
  await map.merge("stale", { receivedAt: 1 });
  now += 5_000;
  await staging.stage("fresh", envelope("message", "1.0"));
  const replayed: string[] = [];
  const replay = async (body: Record<string, unknown>, gate: { failed(reason?: string): void }): Promise<void> => {
    replayed.push((body.event as { ts: string }).ts);
    gate.failed("handler down");
  };
  assert.equal(await staging.sweep(replay), 1);
  assert.deepEqual(replayed, ["3.0"], "only the stale row of this account replays");
  assert.equal(await staging.sweep(replay), 0, "a claimed row is not replayed again inside its claim window");
  staging.accepted("fresh");
  await tick(0);
  now += 10 * 60_000;
  assert.equal(await staging.sweep(replay), 1);
  now += 10 * 60_000;
  assert.equal(await staging.sweep(replay), 0, "after max attempts the row is left alone, not replayed forever");
  assert.ok(await map.get("stale"), "the exhausted row stays visible until the daily sweep");
  assert.ok(await map.get("other"), "another account's row is untouched");
});

test("a replay whose handler durably accepts clears the row through accepted()", async () => {
  const map = createMemoryMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  await staging.stage("k", envelope("message", "1.0"));
  staging.accepted("k");
  await tick(0);
  assert.equal(await map.get("k"), null);
});

test("gate: when the cap fires first, the envelope is staged before the ack; later acceptance clears it", async () => {
  const map = createMemoryMap<StagedEnvelope>();
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
  await tick(40);
  assert.deepEqual(events, ["ack"]);
  assert.ok(await map.get("slack:acct:message:C1:1.0"), "the row exists while acceptance is unknown");
  gate.persisted();
  await tick(0);
  assert.equal(await map.get("slack:acct:message:C1:1.0"), null, "durable acceptance clears the staged row");
});

test("gate: when staging cannot land before the cap, the ack is withheld so Slack redelivers", async () => {
  const map = createMemoryMap<StagedEnvelope>();
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
  const map = createMemoryMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  const body = envelope("message", "1.0");
  const { ack, gate } = createDeferredEnvelopeAck(async () => {}, {
    gated: true,
    capMs: 10,
    ...envelopeStageFor(staging, body),
  });
  await ack();
  await tick(40);
  gate.failed("boom");
  await tick(0);
  assert.ok(await map.get("slack:acct:message:C1:1.0"), "the message the ack already covered is still recoverable");
});

test("a replay clears its row when the handler settles or accepts, keeps it while running, and keeps it on failure", async () => {
  const map = createMemoryMap<StagedEnvelope>();
  let now = 1_000_000;
  const staging = createEnvelopeStaging(map, {
    account: "acct",
    now: () => now,
    staleAfterMs: 1_000,
    replayWaitMs: 20,
  });
  for (const [key, ts] of [
    ["settled", "1.0"],
    ["running", "2.0"],
    ["accepted", "3.0"],
    ["failed", "4.0"],
    ["late", "5.0"],
  ] as const)
    await staging.stage(key, envelope("message", ts));
  now += 5_000;
  let releaseLate: (() => void) | undefined;
  assert.equal(
    await staging.sweep((body, gate) => {
      const ts = (body.event as { ts: string }).ts;
      if (ts === "2.0") return new Promise(() => {});
      if (ts === "3.0") gate.persisted();
      if (ts === "4.0") gate.failed("boom");
      if (ts === "5.0") return new Promise((r) => (releaseLate = () => r()));
      return Promise.resolve();
    }),
    5,
  );
  await tick(0);
  assert.equal(await map.get("settled"), null, "a settled replay (even a silent one) is done with the row");
  assert.equal(await map.get("accepted"), null, "durable acceptance clears the row");
  assert.ok(await map.get("running"), "an unfinished replay keeps its row until the handler accepts it");
  assert.ok(await map.get("failed"), "a replay whose handler failed keeps its row for the next attempt");
  assert.ok(await map.get("late"), "the sweep moved on after its wait");
  releaseLate!();
  await tick(0);
  assert.equal(await map.get("late"), null, "a replay that settles after the wait still clears its row");
});

test("the sweep skips a row another sweeper claimed between the read and the claim", async () => {
  const map = createMemoryMap<StagedEnvelope>();
  let now = 1_000_000;
  const racing: typeof map = {
    ...map,
    update: async (key, fn) => {
      await map.merge(key, { attempts: 1, claimedUntil: now + 60_000 });
      return map.update!(key, fn);
    },
  };
  const staging = createEnvelopeStaging(racing, { account: "acct", now: () => now, staleAfterMs: 1_000 });
  await staging.stage("k", envelope("message", "1.0"));
  now += 5_000;
  let replays = 0;
  assert.equal(
    await staging.sweep(async () => {
      replays++;
    }),
    0,
  );
  assert.equal(replays, 0);
  assert.equal((await map.get("k"))?.attempts, 1, "the other sweeper's claim stands unmodified");
});

test("rows older than a day are dropped whatever their account, so retired apps do not leave garbage", async () => {
  const map = createMemoryMap<StagedEnvelope>();
  const now = 10 * 24 * 60 * 60_000;
  const staging = createEnvelopeStaging(map, { account: "acct", now: () => now });
  await map.put("old", {
    body: envelope("message", "1.0"),
    account: "retired",
    receivedAt: now - 25 * 60 * 60_000,
    attempts: 0,
  });
  await map.put("recent", {
    body: envelope("message", "2.0"),
    account: "retired",
    receivedAt: now - 60_000,
    attempts: 0,
  });
  assert.equal(await staging.sweep(async () => {}), 0);
  assert.equal(await map.get("old"), null);
  assert.ok(await map.get("recent"));
});

test("gate: acceptance that lands while the stage write is still in flight still clears the row once it lands", async () => {
  const map = createMemoryMap<StagedEnvelope>();
  let release: (() => void) | undefined;
  const slowMap: typeof map = {
    ...map,
    putIfAbsent: (key, value) =>
      new Promise((resolve) => {
        release = () => resolve(map.putIfAbsent(key, value));
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
  await tick(10);
  assert.equal(acks, 1);
  assert.equal(await map.get("slack:acct:message:C1:1.0"), null, "the late-landing row is cleared, not orphaned");
});

test("gate: a handler failure after the cap keeps the staged row even though the receiver reports completion", async () => {
  const map = createMemoryMap<StagedEnvelope>();
  const staging = createEnvelopeStaging(map, { account: "acct" });
  const body = envelope("message", "1.0");
  const { ack, gate } = createDeferredEnvelopeAck(async () => {}, {
    gated: true,
    capMs: 10,
    ...envelopeStageFor(staging, body),
  });
  await ack();
  await tick(40);
  gate.failed("boom");
  gate.persisted();
  await tick(0);
  assert.ok(await map.get("slack:acct:message:C1:1.0"), "the row survives the receiver's unconditional persisted()");
});
