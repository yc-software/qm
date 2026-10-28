import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../support/mock-harness.ts";
import type { HarnessTurnInput } from "../../src/harness/harness.ts";
import { hashId } from "../../src/util/crypto.ts";
import { buildTestApp, dm } from "../support/orchestrator-app.ts";
import { testConfig } from "../support/test-config.ts";

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});

test("an approved resume reuses the parked turn's system prompt and carries the approval note in its environment", async () => {
  const seen: HarnessTurnInput[] = [];
  const harness = createMockHarness();
  const run = harness.turns.runTurn;
  harness.turns.runTurn = async (turn) => {
    seen.push(turn);
    return run(turn);
  };
  const config = testConfig();
  config.sandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  const { app } = buildTestApp(config, { harness });
  const call = '!declared {"to":"a@example.com","body":"hi"}';
  const pending = await app.turn(dm(call));
  assert.equal(pending.status, "pending_approval");
  const parked = seen.at(-1)!;
  const approved = await app.turn(
    dm(call, { approval: { requestId: pending.pendingApprovals![0]!.requestId, approved: true } }),
  );
  assert.equal(approved.status, "ok");
  const resumed = seen.at(-1)!;
  assert.notEqual(resumed, parked);
  assert.equal(resumed.systemPrompt, parked.systemPrompt);
  assert.doesNotMatch(resumed.systemPrompt, /approved the pending operation/);
  assert.match(
    resumed.environment ?? "",
    /The requesting human has approved the pending operation for this turn\. Resume that operation instead of requesting the same approval again\./,
  );
  assert.doesNotMatch(parked.environment ?? "", /approved the pending operation/);
});
