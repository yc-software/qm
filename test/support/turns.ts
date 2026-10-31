import assert from "node:assert/strict";
import type { ErrorLog } from "../../src/admin/error-log.ts";
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import { isTerminal, type Run, type RunStore } from "../../src/runs/run-store.ts";
import type { TurnRequest, TurnResult } from "../../src/types.ts";
import type { App } from "../../src/api/app-types.ts";
import { createTurnLedger, type TurnLedger } from "../../src/turns/turn-ledger.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { bindTurnLedger } from "../../src/turns/turn-engine.ts";
import { createTurnRunner, type TurnRunner, type TurnRunnerDeps } from "../../src/turns/turn-runner.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";
import { CONFIG_DEFAULTS } from "../../src/config.ts";
import type { Runtime } from "../../src/wiring.ts";

type Runs = Pick<RunStore, "get" | "activeForThread" | "list">;

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

export async function failedTurnError(
  built: { app: Pick<App, "turn">; errors: Pick<ErrorLog, "flush" | "list"> },
  request: TurnRequest,
): Promise<string> {
  const result = await built.app.turn(request);
  assert.equal(result.status, "failed", JSON.stringify(result));
  await built.errors.flush();
  return (await built.errors.list({ limit: 100 }))
    .filter((event) => event.category === "turn")
    .map((event) => event.message)
    .join("\n");
}

export async function endTurn(claimed: ClaimedTurn, result: TurnResult): Promise<boolean> {
  return finishTurn(claimed, result, result.status === "failed" ? "failed" : "done");
}

export function appLedger(built: { runs: Pick<RunStore, "emitTerminal"> }, databaseUrl: string): TurnLedger {
  const ledger = createTurnLedger(databaseUrl, { onTerminal: (run) => built.runs.emitTerminal(run) });
  after(() => ledger.close());
  return ledger;
}

export async function pauseTurns(built: { runtime: Pick<Runtime, "setBackgroundAdmission"> }): Promise<void> {
  built.runtime.setBackgroundAdmission(
    () => false,
    () => false,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export function resumeTurns(built: { runtime: Pick<Runtime, "setBackgroundAdmission"> }): void {
  built.runtime.setBackgroundAdmission(
    () => true,
    () => false,
  );
}

export function startTurnRunner(
  ledger: TurnLedger,
  orchestrator: TurnRunnerDeps["orchestrator"],
  opts: Partial<Omit<TurnRunnerDeps, "ledger" | "orchestrator">> = {},
): TurnRunner {
  const runner = createTurnRunner({
    ledger,
    orchestrator,
    queues: TURN_QUEUES,
    slots: 1,
    pollMs: 20,
    retryDelayMs: () => 0,
    ...opts,
  });
  runner.start();
  after(() => runner.stopClaims());
  return runner;
}

export async function retryTurn(claimed: ClaimedTurn, delayMs = 0): Promise<boolean> {
  return claimed.ledger.handBack(claimed.run, claimed.token, { stop: { kind: "error" }, delayMs, countsAsError: true });
}
