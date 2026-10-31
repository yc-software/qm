import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createSlackCoreClient, RUN_STALL_BUDGET_MS, type SlackCoreClientDeps } from "../src/api/slack-core-client.ts";
import type { TurnStream } from "../src/runs/turn-stream.ts";
import { queueOf } from "../src/turns/turn-ledger.ts";
import { eventually } from "./support/settle.ts";
import { claimTurn, testRunStore } from "./support/turns.ts";

type Outcome = { error: unknown } | { result: unknown } | null;

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

  let livenessChecks = 0;
  const runs = {
    ...store.runs,
    async leaseHeld(...args: Parameters<typeof store.runs.leaseHeld>) {
      try {
        return await store.runs.leaseHeld(...args);
      } finally {
        livenessChecks += 1;
      }
    },
  };
  const polledTwiceMore = async (): Promise<void> => {
    const seen = livenessChecks;
    await eventually(() => livenessChecks >= seen + 2, { label: "two more liveness polls" });
  };
  const client = createSlackCoreClient({ runs, turnStream: quietStream } as unknown as SlackCoreClientDeps);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let outcome: Outcome = null;
  void client.waitRun(run.id).then(
    (result) => (outcome = { result }),
    (error: unknown) => (outcome = { error }),
  );

  await eventually(() => livenessChecks > 0, { label: "the first liveness poll" });
  t.mock.timers.tick(RUN_STALL_BUDGET_MS + 60_000);
  await polledTwiceMore();
  assert.equal(outcome, null, "a held claim counts as progress past the stall budget");

  await admin.query(
    `UPDATE absurd.r_${queueOf(claimed.run)} SET claim_expires_at = absurd.current_time() - interval '1 second' WHERE run_id = $1`,
    [claimed.run.absurdRunId],
  );
  assert.equal(await store.runs.leaseHeld(claimed.run, claimed.token), false);
  t.mock.timers.tick(RUN_STALL_BUDGET_MS + 60_000);
  const ended = await eventually<Outcome>(() => outcome, { label: "the stalled wait settling" });
  assert.ok(ended && "error" in ended, "a running turn with no held claim is declared stalled");
  assert.equal((ended.error as { code?: string }).code, "run_stalled");
});
