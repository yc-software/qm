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
import { claimTurn, finishTurn } from "./support/turns.ts";
import { createTurnLedger } from "../src/turns/turn-ledger.ts";
import type { TurnRequest } from "../src/types.ts";

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
