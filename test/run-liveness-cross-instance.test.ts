import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { claimTurn } from "./support/turns.ts";
import { eventually } from "./support/settle.ts";
import { createTurnLedger } from "../src/turns/turn-ledger.ts";

function setup(threadRef: string) {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "liveness-")), workers: 0 });
  const built = buildApp(config);
  const otherInstance = createTurnLedger(config.databaseUrl!);
  const enqueue = () =>
    built.runs.enqueue({
      sessionId: threadRef,
      request: {
        surface: "test",
        actor: { id: "u1", type: "internal" },
        conversation: { kind: "dm", threadRef, audience: [{ id: "u1", type: "internal" }] },
        text: "hello",
        origin: { kind: "human" },
      },
    });
  return { built, otherInstance, enqueue, databaseUrl: config.databaseUrl! };
}

test("a run executing on another instance still reports alive", async () => {
  const { built, otherInstance, enqueue } = setup("t1");
  try {
    const { run } = await enqueue();
    const claimed = await claimTurn(otherInstance, run.id);
    assert.equal(claimed?.run.id, run.id, "the foreign worker holds the run");

    const view = await built.app.getRun(run.id);
    assert.equal(view?.status, "running");
    assert.equal(view?.alive, true, "liveness comes from the durable claim, not this instance's memory");
    assert.notEqual(view?.stale, true);
  } finally {
    await built.runtime.stop();
    await otherInstance.close();
  }
});

test("a run whose claim lapsed and was taken over fences the old holder out", async () => {
  const { built, otherInstance, enqueue, databaseUrl } = setup("t2");
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const { run } = await enqueue();
    const lapsed = await claimTurn(otherInstance, run.id);
    assert.ok(lapsed);
    await admin.query(
      `UPDATE absurd.r_${lapsed.run.absurdQueue} SET claim_expires_at = absurd.current_time() - interval '1 second' WHERE run_id = $1`,
      [lapsed.run.absurdRunId],
    );
    const takeover = await eventually(() => claimTurn(otherInstance, run.id), {
      until: (claimed) => claimed !== null,
      label: "an expired claim is claimable again",
    });
    assert.ok(takeover);
    assert.equal(takeover.run.attempts, 2);

    assert.equal(await built.runs.leaseHeld(lapsed.run, lapsed.token), false, "the lapsed holder is fenced");
    const view = await built.app.getRun(run.id);
    assert.equal(view?.alive, true, "liveness follows the new holder");
    assert.equal(await built.runs.leaseHeld(takeover.run, takeover.token), true);
  } finally {
    await admin.end();
    await built.runtime.stop();
    await otherInstance.close();
  }
});
