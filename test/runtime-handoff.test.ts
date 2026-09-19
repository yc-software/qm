import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { sleep, withTimeout } from "../src/util/async.ts";

test("ownership relinquishes before maintenance quiesces and rollback restarts it afterward", async (t) => {
  const built = buildApp(testConfig({ skillSyncPollMs: 1000 }));
  const active = Promise.withResolvers<void>();
  let starts = 0;
  t.mock.method(built.skillSyncEngine, "start", () => {
    starts++;
  });
  t.mock.method(built.skillSyncEngine, "stop", () => active.promise);
  built.runtime.startBackground();
  try {
    await withTimeout(() => built.runtime.stopBackgroundClaims(), 1000, "claim relinquishment");
    let drained = false;
    const draining = built.runtime.backgroundDrained().then(() => {
      drained = true;
    });
    await sleep(10);
    assert.equal(drained, false);
    assert.equal(starts, 1);
    built.runtime.startBackground();
    await sleep(10);
    assert.equal(starts, 1);
    active.resolve();
    await withTimeout(() => draining, 1000, "maintenance completion");
    assert.equal(starts, 2);
  } finally {
    active.resolve();
    await built.runtime.stop();
  }
});

test("a synchronous wait yields its durable run and resumes after ownership returns", async (t) => {
  const built = buildApp(testConfig({ backgroundDeploymentId: "controlled", workers: 1 }));
  let admitted = true;
  built.runtime.setBackgroundAdmission(() => admitted);
  const claimed = Promise.withResolvers<void>();
  const claim = t.mock.method(built.runs, "claimForSession", async () => {
    claimed.resolve();
    return null;
  });
  const request = {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "handoff-wait" },
    text: "hello",
    idempotencyKey: "handoff-wait",
  };
  const result = built.app.turn(request);
  try {
    await claimed.promise;
    admitted = false;
    await built.runtime.stopBackgroundClaims();
    const yielded = await withTimeout(() => result, 1000, "synchronous handoff");
    await built.runtime.backgroundDrained();
    const [run] = await built.runs.list();
    assert.equal(run?.status, "pending");
    assert.deepEqual(yielded, { status: "queued", runId: run?.id });
    assert.equal((await built.app.turn({ ...request, idempotencyKey: "paused" })).status, "refused");
    assert.equal((await built.app.turn({ ...request, async: true })).runId, run?.id);
    claim.mock.restore();
    admitted = true;
    built.runtime.startBackground();
    assert.equal((await built.app.turn(request)).status, "ok");
    assert.equal((await built.runs.list()).length, 1);
  } finally {
    claim.mock.restore();
    await built.runtime.stop();
  }
});

test("cron execution waiting on a durable run yields without finishing its fire", async (t) => {
  const built = buildApp(testConfig({ workers: 1 }));
  const waiting = Promise.withResolvers<void>();
  const claim = t.mock.method(built.runs, "claim", async () => null);
  const inline = t.mock.method(built.runs, "claimForSession", async () => {
    waiting.resolve();
    return null;
  });
  const cron = await built.crons.create({
    owner: "internal:U1",
    createdBy: "internal:U1",
    ownerScopeId: "personal:internal:U1",
    action: "hello",
    schedule: { everyMs: 3_600_000 },
  });
  built.runtime.startBackground();
  const fire = await built.scheduler.runNow(cron.id);
  assert.equal(fire.started, true);
  try {
    await withTimeout(() => waiting.promise, 2000, "cron run admission");
    await built.runtime.stopBackgroundClaims();
    await withTimeout(() => built.runtime.backgroundDrained(), 1000, "cron handoff");
    assert.equal((await built.crons.listFires(cron.id)).runs[0]?.status, "running");
    assert.equal((await built.runs.list()).length, 1);
    inline.mock.restore();
    claim.mock.restore();
    built.runtime.startBackground();
    if (fire.started) await withTimeout(() => fire.settled, 5000, "resumed cron");
    assert.equal((await built.crons.listFires(cron.id)).runs[0]?.status, "ok");
    assert.equal((await built.runs.list()).length, 1);
  } finally {
    inline.mock.restore();
    claim.mock.restore();
    await built.runtime.stop();
  }
});
