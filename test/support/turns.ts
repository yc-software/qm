import { randomUUID } from "node:crypto";
import { isTerminal, type Run, type RunStore } from "../../src/runs/run-store.ts";
import type { TurnRequest, TurnResult } from "../../src/types.ts";
import type { App } from "../../src/api/app-types.ts";
import { createTurnLedger, type TurnLedger } from "../../src/turns/turn-ledger.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { bindTurnLedger } from "../../src/turns/turn-engine.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";
import { CONFIG_DEFAULTS } from "../../src/config.ts";

type Runs = Pick<RunStore, "get" | "activeForThread" | "list">;

/** Poll the run store until `runId` reaches a terminal state. */
export async function settledRun(runs: Pick<Runs, "get">, runId: string, timeoutMs = 30_000): Promise<Run> {
  for (const deadline = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 25))) {
    const run = await runs.get(runId);
    if (run && isTerminal(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
  }
}

export async function settledTurn(
  built: { app: Pick<App, "turn">; runs: Pick<Runs, "get"> },
  request: TurnRequest,
): Promise<TurnResult> {
  const result = await built.app.turn(request);
  if (result.runId) await settledRun(built.runs, result.runId);
  return result;
}

export async function quietThread(built: { runs: Runs }, threadRef: string): Promise<void> {
  for (let run = await built.runs.activeForThread(threadRef); run; run = await built.runs.activeForThread(threadRef)) {
    await settledRun(built.runs, run.id);
  }
}

export async function quietRuns(built: { runs: Runs }): Promise<void> {
  for (;;) {
    const live = (await built.runs.list({ limit: 1_000 })).filter((run) => !isTerminal(run.status));
    if (live.length === 0) return;
    await Promise.all(live.map((run) => settledRun(built.runs, run.id)));
  }
}

export interface ClaimedTurn {
  run: Run;
  token: string;
  ledger: TurnLedger;
}

/** Claims a turn the way the turn runner does: the given one, or the next on any queue. */
export async function claimTurn(ledger: TurnLedger, runId?: string): Promise<ClaimedTurn | null> {
  const passed: ClaimedTurn[] = [];
  try {
    for (const queue of TURN_QUEUES) {
      for (;;) {
        const token = `test:${randomUUID()}`;
        const { claimed, run } = await ledger.claim(queue, token, "test");
        if (!claimed) break;
        if (!run) continue;
        if (!runId || run.id === runId) return { run, token, ledger };
        passed.push({ run, token, ledger });
      }
    }
    return null;
  } finally {
    for (const other of passed) await ledger.handBack(other.run, other.token, { unstarted: true });
  }
}

export async function finishTurn(
  claimed: ClaimedTurn,
  result: TurnResult,
  status: "done" | "failed" = "done",
): Promise<boolean> {
  return claimed.ledger.finish(claimed.run, claimed.token, { status, result });
}

/** Claims the turn and ends it with the given result, as if it had run. */
export async function completeTurn(ledger: TurnLedger, runId: string, result: TurnResult): Promise<Run> {
  const claimed = await claimTurn(ledger, runId);
  if (!claimed) throw new Error(`turn ${runId} could not be claimed`);
  await finishTurn(claimed, result);
  return claimed.run;
}

export interface TestRunStore {
  runs: RunStore;
  ledger: TurnLedger;
  databaseUrl: string;
  close(): Promise<void>;
}

/** A run store on a fresh database, admitting and ending turns through the Absurd ledger as the app does. */
export function testRunStore(databaseUrl = testMigratedDatabaseUrl()): TestRunStore {
  registerAbsurdSchema(databaseUrl);
  const store = createPostgresRunStore(databaseUrl);
  const ledger = createTurnLedger(databaseUrl, { onTerminal: (run) => store.runs.emitTerminal(run) });
  return {
    runs: { ...store.runs, ...bindTurnLedger(store.runs, ledger, CONFIG_DEFAULTS.maxAttempts) },
    ledger,
    databaseUrl,
    async close() {
      await ledger.close();
      await store.close();
    },
  };
}
