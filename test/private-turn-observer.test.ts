import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { PrivateTurnObservation } from "../src/api/private-turn-observer.ts";
import { createPrivateTurnObservationOutbox } from "../src/api/private-turn-observation-outbox.ts";
import { createMemoryTransactionalOutbox } from "../src/persistence/transactional-outbox.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const runtimes: BuiltApp[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((built) => built.runtime.stop()));
});

function build(observe: (input: PrivateTurnObservation) => Promise<"accepted" | "duplicate">, timeoutMs = 100) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-private-observer-")) }), {
    privateTurnObserver: { observe },
    privateTurnObserverTimeoutMs: timeoutMs,
  });
  runtimes.push(built);
  return built;
}

test("production refuses a process-local private-turn observation outbox", () => {
  assert.throws(
    () =>
      buildApp(testConfig({ production: true }), {
        privateTurnObserver: { observe: async () => "accepted" },
      }),
    /production private-turn observer requires DATABASE_URL and RUN_STORE=postgres/u,
  );
});

test("private Slack and web turns emit digest-only observations after durable enqueue", async () => {
  const observations: PrivateTurnObservation[] = [];
  const built = build(async (input) => {
    observations.push(input);
    return "accepted";
  });
  const slackText = "private slack secret";
  const slack = await built.app.turn({
    surface: "slack",
    actor: { externalId: "internal:owner" },
    conversation: { kind: "dm", threadRef: "dm:owner" },
    origin: { kind: "human", messageTs: "123.456" },
    text: slackText,
    async: true,
  });
  const web = await built.app.turn({
    surface: "web",
    actor: { externalId: "internal:owner" },
    conversation: { kind: "dm", threadRef: "web:internal:owner:private" },
    origin: { kind: "human" },
    text: "private web secret",
    async: true,
  });
  assert.equal(slack.status, "queued");
  assert.equal(web.status, "queued");
  assert.deepEqual(
    observations.map((row) => row.source),
    ["slack_dm", "web_chat"],
  );
  assert.match(observations[0]?.eventRef ?? "", /^qm-private-turn:[0-9a-f]{64}$/u);
  assert.notEqual(observations[0]?.eventRef, slack.status === "queued" ? slack.runId : "");
  assert.equal(observations[0]?.principalRef, "internal:owner");
  assert.equal(observations[0]?.audienceRef, "personal:internal:owner");
  assert.equal(observations[0]?.workspaceRef, "org:default-org");
  assert.equal(observations[0]?.inputSha256, createHash("sha256").update(slackText).digest("hex"));
  assert.equal(JSON.stringify(observations).includes(slackText), false);
  assert.equal(JSON.stringify(observations).includes("private web secret"), false);
});

test("a direct private web steer is observed in the signal acceptance transaction", async () => {
  const observations: PrivateTurnObservation[] = [];
  const built = build(async (input) => {
    observations.push(input);
    return "accepted";
  });
  const queued = await built.app.turn({
    surface: "web",
    actor: { externalId: "internal:owner" },
    conversation: { kind: "dm", threadRef: "web:internal:owner:steer" },
    origin: { kind: "human" },
    text: "start private work",
    async: true,
  });
  assert.equal(queued.status, "queued");
  if (queued.status !== "queued") return;
  assert.ok(queued.runId);
  assert.deepEqual(
    await built.app.signalRun(queued.runId, { kind: "steer", text: "private correction" }, "internal:owner"),
    { accepted: true },
  );
  assert.equal(observations.length, 2);
  assert.equal(observations[1]?.source, "web_chat");
  assert.equal(observations[1]?.principalRef, "internal:owner");
  assert.equal(observations[1]?.inputSha256, createHash("sha256").update("private correction").digest("hex"));
  assert.notEqual(observations[0]?.eventRef, observations[1]?.eventRef);
});

test("the optional observer skips channels and automation and preserves deduplicated identity", async () => {
  const observations: PrivateTurnObservation[] = [];
  const seen = new Set<string>();
  const built = build(async (input) => {
    observations.push(input);
    const status = seen.has(input.eventRef) ? "duplicate" : "accepted";
    seen.add(input.eventRef);
    return status;
  });
  const request = {
    surface: "web",
    actor: { externalId: "internal:owner" },
    conversation: { kind: "dm" as const, threadRef: "web:internal:owner:dedupe" },
    origin: { kind: "human" as const },
    text: "same",
    idempotencyKey: "stable-turn",
    async: true,
  };
  const first = await built.app.turn(request);
  const second = await built.app.turn(request);
  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.equal(observations.length, 1);
  assert.match(observations[0]?.eventRef ?? "", /^qm-private-turn:[0-9a-f]{64}$/u);
  await built.app.turn({
    ...request,
    idempotencyKey: "channel",
    conversation: { kind: "channel", threadRef: "channel", channelRef: "C1" },
  });
  await built.app.turn({
    ...request,
    idempotencyKey: "automation",
    origin: { kind: "automation" },
  });
  assert.equal(observations.length, 1);
});

test("Slack source identity survives active-run steering and redelivery without hashing envelope text", async () => {
  const observations: PrivateTurnObservation[] = [];
  const seen = new Set<string>();
  const built = build(async (input) => {
    observations.push(input);
    const status = seen.has(input.eventRef) ? "duplicate" : "accepted";
    seen.add(input.eventRef);
    return status;
  });
  const turn = (text: string, messageTs: string) =>
    built.app.turn({
      surface: "slack",
      actor: { externalId: "internal:owner" },
      conversation: { kind: "dm" as const, threadRef: "dm:steering" },
      origin: { kind: "human" as const, messageTs },
      text,
      async: true,
    });
  assert.equal((await turn("first", "100.001")).status, "queued");
  assert.equal((await turn("exact follow-up", "100.002")).status, "queued");
  assert.equal((await turn("exact follow-up", "100.002")).status, "queued");
  assert.equal(observations.length, 2);
  assert.notEqual(observations[0]?.eventRef, observations[1]?.eventRef);
  assert.equal(observations[1]?.inputSha256, createHash("sha256").update("exact follow-up").digest("hex"));
  assert.equal(JSON.stringify(observations).includes("exact follow-up"), false);

  await turn("missing source identity", "");
  assert.equal(observations.length, 2);
});

test("observer exceptions and timeouts are unconfirmed without changing the accepted turn", async () => {
  const throwing = build(async () => {
    throw new Error("observer unavailable");
  });
  const accepted = await throwing.app.turn({
    surface: "web",
    actor: { externalId: "internal:owner" },
    conversation: { kind: "dm", threadRef: "web:internal:owner:error" },
    origin: { kind: "human" },
    text: "accepted by QM",
    async: true,
  });
  assert.equal(accepted.status, "queued");
  assert.equal((await throwing.auditLog.events()).at(-1)?.status, "unconfirmed");

  const hanging = build(() => new Promise(() => {}), 5);
  const started = Date.now();
  const timed = await hanging.app.turn({
    surface: "slack",
    actor: { externalId: "internal:owner" },
    conversation: { kind: "dm", threadRef: "dm:timeout" },
    origin: { kind: "human", messageTs: "200.001" },
    text: "accepted despite observer timeout",
    async: true,
  });
  assert.equal(timed.status, "queued");
  assert.ok(Date.now() - started < 500);
  assert.equal((await hanging.auditLog.events()).at(-1)?.status, "unconfirmed");
});

test("observer timeout configuration is bounded before the app accepts work", () => {
  for (const privateTurnObserverTimeoutMs of [0, -1, 10_001, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        buildApp(testConfig(), {
          privateTurnObserver: { observe: async () => "accepted" },
          privateTurnObserverTimeoutMs,
        }),
      /privateTurnObserverTimeoutMs must be an integer from 1 through 10000/,
    );
  }
});

test("durable observation delivery recovers after timeout and process restart", async () => {
  const storage = createMemoryTransactionalOutbox();
  let now = Date.parse("2026-08-27T12:00:00.000Z");
  let mode: "hang" | "accept" = "hang";
  let calls = 0;
  const downstream = {
    observe: async () => {
      calls += 1;
      if (mode === "hang") return new Promise<"accepted">(() => {});
      return "accepted" as const;
    },
  };
  const observation: PrivateTurnObservation = {
    source: "web_chat",
    eventRef: `qm-private-turn:${"a".repeat(64)}`,
    conversationRef: "web:internal:owner:recovery",
    principalRef: "internal:owner",
    audienceRef: "personal:internal:owner",
    workspaceRef: "org:default-org",
    observedAt: "2026-08-27T12:00:00.000Z",
    inputSha256: "b".repeat(64),
  };
  const first = createPrivateTurnObservationOutbox({
    storage,
    downstream,
    timeoutMs: 2,
    now: () => now,
    leaseToken: () => "first-lease",
    retryBaseMs: 10,
  });
  assert.equal(await first.observe(observation), "unconfirmed");
  assert.equal((await storage.get(observation.eventRef))?.state, "pending");

  mode = "accept";
  now += 10;
  const restarted = createPrivateTurnObservationOutbox({
    storage,
    downstream,
    timeoutMs: 2,
    now: () => now,
    leaseToken: () => "second-lease",
    retryBaseMs: 10,
  });
  assert.deepEqual(await restarted.sweep(), { attempted: 1, delivered: 1, pending: 0 });
  assert.equal((await storage.get(observation.eventRef))?.state, "delivered");
  assert.equal(await restarted.observe(observation), "duplicate");
  assert.equal(calls, 2);
});

test("durable observation delivery serializes concurrent attempts and rejects divergent reuse", async () => {
  const storage = createMemoryTransactionalOutbox();
  let release: (() => void) | undefined;
  let calls = 0;
  const outbox = createPrivateTurnObservationOutbox({
    storage,
    timeoutMs: 100,
    leaseToken: () => "stable-lease",
    downstream: {
      observe: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "accepted";
      },
    },
  });
  const observation: PrivateTurnObservation = {
    source: "slack_dm",
    eventRef: `qm-private-turn:${"c".repeat(64)}`,
    conversationRef: "dm:owner",
    principalRef: "internal:owner",
    audienceRef: "personal:internal:owner",
    workspaceRef: "org:default-org",
    observedAt: "2026-08-27T12:00:00.000Z",
    inputSha256: "d".repeat(64),
  };
  assert.equal(outbox.entry(observation).id, observation.eventRef);
  const first = outbox.observe(observation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await outbox.observe(observation), "unconfirmed");
  release?.();
  assert.equal(await first, "accepted");
  assert.equal(calls, 1);
  await assert.rejects(outbox.observe({ ...observation, inputSha256: "e".repeat(64) }), /identity is already bound/u);
});

test("observation sweeps are single-flight and bounded while a delivery is slow", async () => {
  const storage = createMemoryTransactionalOutbox();
  let release: (() => void) | undefined;
  let calls = 0;
  const outbox = createPrivateTurnObservationOutbox({
    storage,
    timeoutMs: 1_000,
    downstream: {
      async observe() {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        return "accepted";
      },
    },
  });
  for (let index = 0; index < 3; index += 1) {
    await storage.stage(
      outbox.entry({
        source: "web_chat",
        eventRef: `qm-private-turn:${String(index).repeat(64)}`,
        conversationRef: `web:owner:${index}`,
        principalRef: "internal:owner",
        audienceRef: "personal:internal:owner",
        workspaceRef: "org:default-org",
        observedAt: new Date(Date.now() - 1_000).toISOString(),
        inputSha256: String(index + 3).repeat(64),
      }),
    );
  }
  const first = outbox.sweep(2);
  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = outbox.sweep(100);
  assert.strictEqual(overlapping, first);
  release?.();
  assert.deepEqual(await first, { attempted: 2, delivered: 2, pending: 0 });
  assert.equal(calls, 2);
  assert.deepEqual(await outbox.sweep(2), { attempted: 1, delivered: 1, pending: 0 });
});
