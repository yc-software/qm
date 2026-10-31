import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { claimTurn, testRunStore } from "./support/turns.ts";

test("an autocommit fence check takes no row locks, so it cannot deadlock against a turn being written", async () => {
  const store = testRunStore();
  after(() => store.close());
  const actor = { id: "U1", type: "internal" as const };
  const request: OrchestratorInput = {
    actor,
    conversation: { kind: "dm", threadRef: "fence", audience: [actor] },
    origin: { kind: "human" },
    text: "work",
  };
  const { run } = await store.runs.enqueue({ sessionId: "fence", request });
  const claimed = await claimTurn(store.ledger, run.id);
  assert.ok(claimed?.run.absurdQueue && claimed.run.absurdRunId);
  const writer = new pg.Client({ connectionString: store.databaseUrl });
  await writer.connect();
  after(() => writer.end());
  await writer.query("BEGIN");
  await writer.query("UPDATE runs SET delivery_state = delivery_state WHERE id = $1", [run.id]);
  const held = store.runs.leaseHeld(claimed.run, claimed.token);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await writer.query(
    `UPDATE absurd.${pg.escapeIdentifier(`r_${claimed.run.absurdQueue}`)} SET state = state WHERE run_id = $1`,
    [claimed.run.absurdRunId],
  );
  await writer.query("COMMIT");
  assert.equal(await held, true, "the fence reads the held claim without blocking on the writer");
});
