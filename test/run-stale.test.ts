import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { claimTurn, finishTurn } from "./support/turns.ts";
import { createTurnLedger, queueOf } from "../src/turns/turn-ledger.ts";

test("getRun reports stale exactly when no live worker owns a previously-claimed run", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "run-stale-")),
    backgroundWorkEnabled: false,
  });
  const built = buildApp(config);
  const ledger = createTurnLedger(config.databaseUrl!);
  const admin = new pg.Client({ connectionString: config.databaseUrl });
  await admin.connect();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "x",
      async: true,
    });
    const runId = ack.runId!;

    assert.equal(
      (await built.app.getRun(runId))?.stale,
      undefined,
      "a fresh pending run was never claimed — not stale",
    );

    const claimed = await claimTurn(ledger, runId);
    assert.ok(claimed);
    assert.equal((await built.app.getRun(runId))?.stale, undefined, "running on a held claim — not stale");

    await admin.query(`UPDATE absurd.r_${queueOf(claimed.run)} SET state = 'failed' WHERE run_id = $1`, [
      claimed.run.absurdRunId,
    ]);
    assert.equal((await built.app.getRun(runId))?.stale, true, "running without a held claim — the worker is gone");
    await admin.query(`UPDATE absurd.r_${queueOf(claimed.run)} SET state = 'running' WHERE run_id = $1`, [
      claimed.run.absurdRunId,
    ]);
    assert.equal((await built.app.getRun(runId))?.stale, undefined, "a held claim clears staleness");

    assert.equal(await ledger.handBack(claimed.run, claimed.token, {}), true);
    assert.equal(
      (await built.app.getRun(runId))?.stale,
      true,
      "handed back after a claim (deploy drain) — awaiting re-claim",
    );

    const reclaimed = await claimTurn(ledger, runId);
    assert.ok(reclaimed);
    assert.equal((await built.app.getRun(runId))?.stale, undefined, "re-claimed — not stale");

    assert.equal(
      await finishTurn(reclaimed, { status: "ok", sessionId: reclaimed.run.sessionId, reply: "done" }),
      true,
    );
    assert.equal((await built.app.getRun(runId))?.stale, undefined, "terminal runs are never stale");
  } finally {
    await admin.end();
    await ledger.close();
  }
});
