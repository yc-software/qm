import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { appLedger, claimTurn, finishTurn, retryTurn } from "./support/turns.ts";
import type { Config } from "../src/config.ts";
import type { TurnRequest } from "../src/types.ts";

const request: TurnRequest = {
  surface: "test",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: "inline-retry" },
  text: "hello",
  idempotencyKey: "inline-retry",
};

function build(overrides: Partial<Config>) {
  const config = testConfig(overrides);
  const built = buildApp(config);
  return { built, ledger: appLedger(built, config.databaseUrl!) };
}

const RETRY_DELAY_MS = 1_500;

for (const laterMessage of [false, true]) {
  test(`a synchronous turn waits out a retry backoff: later message=${laterMessage}`, { timeout: 15_000 }, async () => {
    const { built, ledger } = build({ runWaitMs: 10_000 });
    const queued = await built.app.turn({ ...request, async: true });
    const claimed = await claimTurn(ledger, queued.runId!);
    assert.ok(claimed);
    assert.equal(await retryTurn(claimed, { dueInMs: RETRY_DELAY_MS }), true);
    let settled = false;
    const started = Date.now();
    const pending = built.app.turn(laterMessage ? { ...request, text: "next", idempotencyKey: "next" } : request);
    const outcome = pending.then((result) => {
      settled = true;
      return result;
    });
    await sleep(RETRY_DELAY_MS / 3);
    assert.equal(settled, false);
    assert.equal((await built.runs.get(queued.runId!))?.attempts, 1);
    const result = await outcome;
    assert.ok(Date.now() - started >= RETRY_DELAY_MS * 0.5, "the retry was not taken before its backoff");
    assert.equal(result.status, "ok");
    assert.match(result.reply!, laterMessage ? /next/ : /hello/);
  });
}

test("synchronous waiting respects its timeout without clearing a retry deadline", async () => {
  const { built, ledger } = build({ runWaitMs: 100 });
  const queued = await built.app.turn({ ...request, async: true });
  const claimed = await claimTurn(ledger, queued.runId!);
  assert.ok(claimed);
  assert.equal(await ledger.retry(claimed.run, claimed.token, { kind: "error" }), true);
  await assert.rejects(built.app.turn(request), /did not finish within 100ms/);
  assert.equal(await claimTurn(ledger, claimed.run.id), null);
  const run = await built.runs.get(claimed.run.id);
  assert.equal(run?.status, "pending");
  assert.equal(run?.attempts, 1);
});

test("synchronous waiting returns another worker's result without executing twice", async () => {
  const { built, ledger } = build({ runWaitMs: 5_000 });
  const queued = await built.app.turn({ ...request, async: true });
  const claimed = await claimTurn(ledger, queued.runId!);
  assert.ok(claimed);
  const pending = built.app.turn(request);
  await sleep(50);
  assert.equal(
    await finishTurn(claimed, { status: "ok", sessionId: claimed.run.sessionId, reply: "other worker" }),
    true,
  );
  assert.equal((await pending).reply, "other worker");
  assert.equal((await built.runs.get(claimed.run.id))?.attempts, 1);
});
