import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { createSlackCoreClient, type SlackCoreClientDeps } from "../src/api/slack-core-client.ts";
import type { TurnStream } from "../src/runs/turn-stream.ts";
import { claimTurn, testRunStore } from "./support/turns.ts";

const STALL_BUDGET_MS = 300_000;

const quietStream = {
  subscribe: () => () => {},
  replying: () => false,
  surfacePosted: () => false,
  goal: () => undefined,
  firstBlock: () => undefined,
} as unknown as TurnStream;

test("a running turn whose claim is held is never declared stalled, however long it runs", async (t) => {
  const store = testRunStore();
  const admin = new pg.Client({ connectionString: store.databaseUrl });
  await admin.connect();
  t.after(async () => {
    await admin.end();
    await store.close();
  });
  const actor = { id: "internal:U1", type: "internal" as const };
  const threadRef = `slack-stall-${randomUUID()}`;
  const { run } = await store.runs.enqueue({
    sessionId: threadRef,
    request: {
      actor,
      conversation: { kind: "dm", threadRef, audience: [actor] },
      origin: { kind: "human" },
      text: "a long turn",
    },
  });
  const claimed = await claimTurn(store.ledger, run.id);
  assert.ok(claimed);

  const client = createSlackCoreClient({ runs: store.runs, turnStream: quietStream } as unknown as SlackCoreClientDeps);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let outcome: { error: unknown } | { result: unknown } | null = null;
  void client.waitRun(run.id).then(
    (result) => (outcome = { result }),
    (error: unknown) => (outcome = { error }),
  );

  await sleep(200);
  t.mock.timers.tick(STALL_BUDGET_MS + 60_000);
  await sleep(2_500);
  assert.equal(outcome, null, "a held claim counts as progress past the stall budget");

  await admin.query(
    `UPDATE absurd.r_${claimed.run.absurdQueue} SET claim_expires_at = absurd.current_time() - interval '1 second' WHERE run_id = $1`,
    [claimed.run.absurdRunId],
  );
  assert.equal(await store.runs.leaseHeld(claimed.run, claimed.token), false);
  t.mock.timers.tick(STALL_BUDGET_MS + 60_000);
  for (let i = 0; i < 50 && outcome === null; i++) await sleep(100);
  assert.ok(outcome && "error" in outcome, "a running turn with no held claim is declared stalled");
  assert.equal((outcome.error as { code?: string }).code, "run_stalled");
});
