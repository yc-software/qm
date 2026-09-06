import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { wireRunResultDeliveries } from "../src/delivery/run-result-delivery.ts";
import { createTranscriptSource } from "../src/harness/tape-projection.ts";
import { sleep } from "../src/util/async.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { DeliveryProvenance, Destination, Principal, ScopeId, TurnResult } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const THREAD = "web:alice@example.com:conv-1";
const SCOPE = "personal:alice@example.com" as ScopeId;

const cronProvenance = (over: Partial<DeliveryProvenance> = {}): DeliveryProvenance => ({
  trigger: "cron",
  surface: "cron",
  fireKey: "agent:main:cron:c1:100",
  sourceScopeId: SCOPE,
  sourceThreadRef: "agent:main:cron:c1",
  sourceSessionId: "cron-session",
  ...over,
});

const webDestination = (target = THREAD): Destination => ({ type: "web", target, audienceScopeId: SCOPE });

async function webSession(sessions: SessionStore, threadRef = THREAD) {
  return sessions.getOrCreateByThread(threadRef, "dm", SCOPE, undefined, "web");
}

function wired() {
  const sessions = createMemorySessionStore();
  const inner = createDeliveryStore();
  const deliveries = withWebTranscriptDeliveries(inner, sessions);
  return { sessions, inner, deliveries };
}

function quietErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => (console.error = original) };
}

test("enqueue stays a plain insert; the drain writes the text durably before the delivery is visible", async () => {
  const { sessions, deliveries } = wired();
  const session = await webSession(sessions);

  await deliveries.enqueue({
    destination: webDestination(),
    text: "Reminder: standup in 10 minutes",
    idempotencyKey: "agent:main:cron:c1:100",
    provenance: cronProvenance(),
  });
  assert.equal((await sessions.getEntries(session.id)).length, 0, "no transcript side effect at enqueue time");

  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1, "the delivery is visible once its text is durable");

  const entries = await sessions.getEntries(session.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.type, "assistant");
  assert.deepEqual(entries[0]!.payload, {
    text: "Reminder: standup in 10 minutes",
    deliveryKey: "agent:main:cron:c1:100",
    via: "cron",
  });

  const tape = await sessions.getTape(session.id);
  const modelRow = tape.find((row) => row.kind === "message");
  assert.ok(modelRow, "the model sees the delivered text on future turns");
  const content = (modelRow!.payload as { role: string; content: Array<{ text: string }> }).content[0]!.text;
  assert.match(content, /<message from="agent" via="cron"/);
  assert.match(content, /Reminder: standup in 10 minutes/);
  assert.equal((modelRow!.payload as { role?: string }).role, "user", "delivered text is never in assistant voice");
});

test("the recorded entry keeps the tape projection servable and renders through it", async () => {
  const { sessions, deliveries } = wired();
  const session = await webSession(sessions);

  await deliveries.enqueue({
    destination: webDestination(),
    text: "cron reply body",
    idempotencyKey: "agent:main:cron:c1:200",
    provenance: cronProvenance({ fireKey: "agent:main:cron:c1:200" }),
  });
  await deliveries.pending("web");

  assert.equal(await sessions.tapeCoverage(session.id), 0, "the write advances tape coverage over its own entry");
  const projected = (await createTranscriptSource(sessions).forRender(session.id)).entries;
  assert.equal(projected.length, 1);
  assert.equal(projected[0]!.type, "assistant");
  assert.equal((projected[0]!.payload as { text?: string }).text, "cron reply body");
});

test("a session whose tape is already behind gets the entry but no orphan tape rows", async () => {
  const { sessions, deliveries } = wired();
  const session = await webSession(sessions);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  await sessions.append(lease!, { type: "user", payload: { text: "hi" }, scopeLabel: SCOPE });
  await sessions.releaseLease(lease!);

  await deliveries.enqueue({
    destination: webDestination(),
    text: "delivered into a stale tape",
    idempotencyKey: "k-stale-tape",
    provenance: cronProvenance(),
  });
  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1);

  const entries = await sessions.getEntries(session.id);
  assert.equal(entries.length, 2, "the transcript entry still lands");
  const tape = await sessions.getTape(session.id);
  assert.equal(tape.length, 0, "no tape rows without their covering annotation (heal owns this session)");
});

test("repeated drains and a restarted decorator never duplicate the transcript entry", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);

  await deliveries.enqueue({
    destination: webDestination(),
    text: "fire once",
    idempotencyKey: "agent:main:cron:c1:300",
    provenance: cronProvenance({ fireKey: "agent:main:cron:c1:300" }),
  });
  await deliveries.pending("web");
  await deliveries.pending("web");
  const restarted = withWebTranscriptDeliveries(inner, sessions);
  await restarted.pending("web");

  assert.equal((await sessions.getEntries(session.id)).length, 1, "one entry across drains and restarts");
});

test("a failed tape write converges on retry: one entry, no duplicate model rows", async () => {
  const sessions = createMemorySessionStore();
  let failNextTape = true;
  const flaky = {
    ...sessions,
    appendTape: async (...args: Parameters<SessionStore["appendTape"]>) => {
      if (failNextTape) {
        failNextTape = false;
        throw new Error("transient tape failure");
      }
      return sessions.appendTape(...args);
    },
  };
  const inner = createDeliveryStore();
  const deliveries = withWebTranscriptDeliveries(inner, flaky);
  const session = await webSession(sessions);

  await deliveries.enqueue({
    destination: webDestination(),
    text: "written exactly once",
    idempotencyKey: "k-flaky",
    provenance: cronProvenance(),
  });
  assert.deepEqual(await deliveries.pending("web"), [], "held back while the write is incomplete");
  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1, "the retry dedupes on the entry and delivers");

  assert.equal((await sessions.getEntries(session.id)).length, 1);
  const modelRows = (await sessions.getTape(session.id)).filter((row) => row.kind === "message");
  assert.ok(modelRows.length <= 1, "the model never sees the delivered text twice");
});

test("a busy session lease holds the delivery back, unacked, until the write lands", async () => {
  const { sessions, deliveries } = wired();
  const session = await webSession(sessions);
  const { lease } = await sessions.acquireLease(session.id, "turn");

  await deliveries.enqueue({
    destination: webDestination(),
    text: "delayed but durable",
    idempotencyKey: "k-busy",
    provenance: cronProvenance(),
  });
  assert.deepEqual(await deliveries.pending("web"), [], "not visible (and so never acked) while the turn runs");
  assert.equal((await sessions.getEntries(session.id)).length, 0);

  await sessions.releaseLease(lease!);
  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1);
  assert.equal((await sessions.getEntries(session.id)).length, 1);
});

test("a lease wedged past the giveup window degrades to a loud nudge-only delivery", async () => {
  const { sessions, inner, deliveries } = wired();
  await webSession(sessions);
  const session = await sessions.getByThread(THREAD);
  await sessions.acquireLease(session!.id, "turn");

  const row = await deliveries.enqueue({
    destination: webDestination(),
    text: "stuck behind a wedged lease",
    idempotencyKey: "k-wedged",
    provenance: cronProvenance(),
  });
  row.createdAt = Date.now() - 11 * 60_000;
  const { lines, restore } = quietErrors();
  try {
    const drained = await deliveries.pending("web");
    assert.equal(drained.length, 1, "the row is released rather than parked forever");
  } finally {
    restore();
  }
  assert.ok(lines.some((line) => line.includes("k-wedged")));
  assert.equal((await sessions.getEntries(session!.id)).length, 0);
  assert.equal((await inner.pending("web")).length, 1, "still pending for the BFF's own giveup/ack");
});

test("non-web deliveries pass through untouched", async () => {
  const { sessions, deliveries } = wired();
  const session = await webSession(sessions);
  await deliveries.enqueue({
    destination: { type: "slack", target: "C9" },
    text: "slack text",
    idempotencyKey: "k-slack",
    provenance: cronProvenance(),
  });
  assert.equal((await deliveries.pending("slack")).length, 1);
  assert.equal((await sessions.getEntries(session.id)).length, 0);
});

test("legacy rows without provenance or a note are delivered as a nudge, never rewritten", async () => {
  const { sessions, deliveries } = wired();
  const session = await webSession(sessions);
  await deliveries.enqueue({
    destination: webDestination(),
    text: "reply the old build already wrote to the transcript",
    idempotencyKey: "run:legacy-1",
  });
  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1);
  assert.equal((await sessions.getEntries(session.id)).length, 0, "cutover rows keep pre-reshape behavior");
});

test("a spine post to the session's own thread is nudged, not settled and not rewritten", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  await deliveries.enqueue({
    destination: webDestination(),
    text: "mid-turn post already in the tape as a tool call",
    idempotencyKey: `post:${session.id}:x1`,
    provenance: cronProvenance({ trigger: "conversation", sourceThreadRef: THREAD, sourceSessionId: session.id }),
  });
  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1, "open tabs still get their refetch nudge");
  assert.equal((await sessions.getEntries(session.id)).length, 0);
  assert.equal((await inner.pending("web")).length, 1, "not acked at drain — the BFF settles it");
});

test("a web delivery whose target session is missing is delivered as a nudge, loudly", async () => {
  const { sessions, deliveries } = wired();
  await webSession(sessions);
  const { lines, restore } = quietErrors();
  try {
    await deliveries.enqueue({
      destination: webDestination("web:nobody@example.com:gone"),
      text: "orphaned",
      idempotencyKey: "k-orphan",
      provenance: cronProvenance(),
    });
    const drained = await deliveries.pending("web");
    assert.equal(drained.length, 1, "the nudge still flows");
  } finally {
    restore();
  }
  assert.ok(lines.some((line) => line.includes("web:nobody@example.com:gone")));
  assert.equal((await sessions.scanAll()).length, 1, "no odd session state is invented for the dead target");
});

const actor: Principal = { id: "alice@example.com", type: "internal" };
const webTurn = (threadRef: string): OrchestratorInput => ({
  surface: "web",
  deliveryTarget: threadRef,
  actor,
  conversation: { kind: "dm", threadRef, audience: [actor] },
  origin: { kind: "direct" },
  text: "do the thing",
});

async function terminalRun(
  deliveries: DeliveryStore,
  inner: DeliveryStore,
  result: TurnResult | { fail: string },
  duringTurn?: () => Promise<void>,
): Promise<string> {
  const { runs } = createMemoryRunStore();
  wireRunResultDeliveries(runs, deliveries);
  const run = (await runs.enqueue({ sessionId: THREAD, request: webTurn(THREAD), maxAttempts: 1 })).run;
  const claimed = await runs.claim("w1", 5_000);
  await duringTurn?.();
  if ("fail" in result) await runs.fail(run.id, claimed?.leaseToken ?? "", result.fail, { retry: true });
  else await runs.complete(run.id, claimed?.leaseToken ?? "", result);
  const deadline = Date.now() + 2_000;
  while ((await inner.pending("web")).length === 0 && Date.now() < deadline) await sleep(5);
  return run.id;
}

test("a parked web run's failure note lands as a turn_failure entry the web transcript renders", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  await terminalRun(deliveries, inner, { fail: "lease expired (reaped)" });

  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1, "the failure note still nudges");
  const entries = await sessions.getEntries(session.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.type, "system");
  const payload = entries[0]!.payload as { kind?: string; message?: string; runId?: string };
  assert.equal(payload.kind, "turn_failure");
  assert.match(payload.message ?? "", /I couldn't finish that turn: something went wrong on my end/);
  assert.doesNotMatch(payload.message ?? "", /lease expired/, "the internal park reason never reaches the transcript");
  assert.ok(payload.runId, "carries the run id so the surface-agnostic onTerminal recorder stays idempotent");
});

test("an onTerminal-recorded failure entry suppresses the web drain's duplicate for the same run", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  const runs = createMemoryRunStore().runs;
  wireRunResultDeliveries(runs, inner, undefined, undefined, sessions);
  const run = (await runs.enqueue({ sessionId: THREAD, request: webTurn(THREAD), maxAttempts: 1 })).run;
  const claimed = await runs.claim("w1", 5_000);
  await runs.fail(run.id, claimed?.leaseToken ?? "", "lease expired (reaped)", { retry: true });
  const deadline = Date.now() + 2_000;
  while ((await inner.pending("web")).length === 0 && Date.now() < deadline) await sleep(5);

  let drained = await deliveries.pending("web");
  for (let i = 0; i < 100 && drained.length === 0; i++) {
    await sleep(10);
    drained = await deliveries.pending("web");
  }
  assert.equal(drained.length, 1, "the nudge still flows");
  const failures = (await sessions.getEntries(session.id)).filter(
    (e) => e.type === "system" && (e.payload as { kind?: string }).kind === "turn_failure",
  );
  assert.equal(failures.length, 1, "one durable record per failed run across both writers");
});

test("a failure the orchestrator already recorded for this run is not written twice", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  await terminalRun(deliveries, inner, { fail: "boom" }, async () => {
    const { lease } = await sessions.acquireLease(session.id, "turn");
    await sessions.append(lease!, {
      type: "system",
      payload: { kind: "turn_failure", message: "boom" },
      scopeLabel: SCOPE,
    });
    await sessions.releaseLease(lease!);
  });
  await deliveries.pending("web");

  const failures = (await sessions.getEntries(session.id)).filter(
    (e) => e.type === "system" && (e.payload as { kind?: string }).kind === "turn_failure",
  );
  assert.equal(failures.length, 1, "the in-turn record already covers the failure");
});

test("another run's failure record never suppresses this run's note", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  await sessions.append(lease!, {
    type: "system",
    payload: { kind: "turn_failure", message: "earlier run, delivered note", deliveryKey: "run:other" },
    scopeLabel: SCOPE,
  });
  await sessions.append(lease!, {
    type: "system",
    payload: { kind: "turn_failure", message: "overlapping run, in-turn record", runId: "other-run" },
    scopeLabel: SCOPE,
  });
  await sessions.releaseLease(lease!);
  await terminalRun(deliveries, inner, { fail: "boom" });
  await deliveries.pending("web");

  const failures = (await sessions.getEntries(session.id)).filter(
    (e) => e.type === "system" && (e.payload as { kind?: string }).kind === "turn_failure",
  );
  assert.equal(failures.length, 3, "suppression is keyed to this run's own record");
});

test("a recovered reply already recorded by its own turn is settled without a rewrite or a nudge", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  await terminalRun(deliveries, inner, {
    status: "ok",
    sessionId: session.id,
    reply: "already in the tape",
    sourceAssistantEntrySeq: 6,
  });

  assert.deepEqual(await deliveries.pending("web"), [], "nothing new to fetch, so nothing to nudge");
  assert.equal((await sessions.getEntries(session.id)).length, 0);
  assert.deepEqual(await inner.pending("web"), [], "the row is acked, not stuck pending");
});

test("a recovered attachments-only reply is nudged, never silently settled away", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  const atts = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  await terminalRun(deliveries, inner, {
    status: "ok",
    sessionId: session.id,
    reply: "",
    attachments: atts,
    sourceAssistantEntrySeq: 6,
  });

  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1, "the attachments ride the nudge instead of being acked away");
  assert.deepEqual(drained[0]!.attachments, atts);
  assert.equal((await sessions.getEntries(session.id)).length, 0);
});

test("a recovered reply the turn never recorded is written into the transcript, in the agent's plain voice", async () => {
  const { sessions, inner, deliveries } = wired();
  const session = await webSession(sessions);
  await terminalRun(deliveries, inner, { status: "ok", sessionId: session.id, reply: "recovered reply" });

  const drained = await deliveries.pending("web");
  assert.equal(drained.length, 1);
  const entries = await sessions.getEntries(session.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.type, "assistant");
  assert.deepEqual(entries[0]!.payload, { text: "recovered reply", deliveryKey: drained[0]!.idempotencyKey });
  const modelRow = (await sessions.getTape(session.id)).find((row) => row.kind === "message");
  const content = (modelRow!.payload as { content: Array<{ text: string }> }).content[0]!.text;
  assert.doesNotMatch(content, /via=/, "the turn's own reply carries no delivery badge");
});
