import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { claimTurn, finishTurn, testRunStore } from "./support/turns.ts";
import { eventually } from "./support/settle.ts";
import { createTurnLedger } from "../src/turns/turn-ledger.ts";
import type { TurnRequest } from "../src/types.ts";
import { WORK_ADMISSION_CLOSED } from "../src/util/admitted-work.ts";

test(
  "a synchronous turn waiting on a run another worker holds does not run it again",
  { timeout: 30_000 },
  async () => {
    const config = testConfig({
      runWaitMs: 5_000,
      dataDir: mkdtempSync(join(tmpdir(), "inline-wait-")),
    });
    const built = buildApp(config);
    const ledger = createTurnLedger(config.databaseUrl!);
    try {
      const request: TurnRequest = {
        surface: "test",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `inline-wait-${randomUUID()}` },
        text: "hello",
        idempotencyKey: `held-${randomUUID()}`,
      };
      const queued = await built.app.turn({ ...request, async: true });
      const held = await claimTurn(ledger, queued.runId!);
      assert.ok(held);
      const waiting = built.app.turn(request);
      await sleep(500);
      assert.equal(built.modelCalls.length, 0, "the held turn was not run by the waiting caller's runner");
      assert.equal((await built.runs.get(held.run.id))?.leaseToken, held.token);
      assert.equal(
        await finishTurn(held, { status: "ok", sessionId: held.run.sessionId, reply: "done elsewhere" }),
        true,
      );
      const result = await waiting;
      assert.equal(result.status, "ok");
      assert.equal(result.reply, "done elsewhere");
      assert.equal(built.modelCalls.length, 0);
      assert.equal((await built.runs.get(held.run.id))?.attempts, 1);
    } finally {
      await built.runtime.stop();
      await ledger.close();
    }
  },
);

test("a synchronous wait returns as soon as shutdown starts, marked for a retry", { timeout: 30_000 }, async () => {
  const config = testConfig({
    runWaitMs: 20_000,
    dataDir: mkdtempSync(join(tmpdir(), "inline-wait-")),
  });
  const built = buildApp(config);
  const ledger = createTurnLedger(config.databaseUrl!);
  try {
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `inline-wait-${randomUUID()}` },
      text: "hello",
      idempotencyKey: `held-${randomUUID()}`,
    };
    const queued = await built.app.turn({ ...request, async: true });
    const held = await claimTurn(ledger, queued.runId!);
    assert.ok(held);
    const waiting = built.app.turn(request);
    await sleep(300);
    const started = performance.now();
    await built.runtime.releaseInFlightRuns();
    const result = await waiting;
    assert.ok(performance.now() - started < 2_000, "the waiter wakes on shutdown instead of its next recheck");
    assert.equal(result.status, "queued");
    assert.equal(result.errorCode, WORK_ADMISSION_CLOSED);
    assert.equal(result.runId, held.run.id);
  } finally {
    await built.runtime.stop();
    await ledger.close();
  }
});

test("stopping hands a running turn back at once instead of after the drain window", { timeout: 30_000 }, async () => {
  const config = testConfig({
    shutdownDrainMs: 15_000,
    dataDir: mkdtempSync(join(tmpdir(), "stop-handback-")),
  });
  const built = buildApp(config);
  built.runtime.start();
  let stopped = false;
  try {
    const queued = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `stop-handback-${randomUUID()}` },
      text: "!work-until-shutdown",
      async: true,
    });
    await eventually(async () => (await built.runs.get(queued.runId!))?.status, {
      until: (status) => status === "running",
      label: "the turn is running",
    });
    const started = performance.now();
    await built.runtime.stop();
    stopped = true;
    assert.ok(performance.now() - started < 5_000, "the stop did not wait out the drain window");
    const store = testRunStore(config.databaseUrl!);
    try {
      const run = await store.runs.get(queued.runId!);
      assert.equal(run?.status, "pending", "the turn is back in the queue for another process");
      assert.deepEqual(run?.lastStop, { kind: "shutdown" });
    } finally {
      await store.close();
    }
  } finally {
    if (!stopped) await built.runtime.stop();
  }
});
