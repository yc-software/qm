import assert from "node:assert/strict";
import type { ErrorLog } from "../../src/admin/error-log.ts";
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import { isTerminal, type Run, type RunStop, type RunStore } from "../../src/runs/run-store.ts";
import type { TurnRequest, TurnResult } from "../../src/types.ts";
import type { App } from "../../src/api/app-types.ts";
import { createTurnLedger, type TurnLedger } from "../../src/turns/turn-ledger.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { bindTurnLedger } from "../../src/turns/turn-engine.ts";
import { createTurnRunner, type TurnRunner, type TurnRunnerDeps } from "../../src/turns/turn-runner.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";
import { retryDue } from "./absurd-clock.ts";
import { eventually } from "./settle.ts";
import { CONFIG_DEFAULTS } from "../../src/config.ts";
import type { Runtime } from "../../src/wiring.ts";

export async function settledRun(runs: Pick<RunStore, "get">, runId: string, timeoutMs = 30_000): Promise<Run> {
  const run = await eventually(() => runs.get(runId), {
    until: (found) => found !== null && isTerminal(found.status),
    timeoutMs,
    label: `run ${runId} finishing`,
  });
  return run!;
}

const ledgerUrls = new WeakMap<TurnLedger, string>();

function tracked(ledger: TurnLedger, databaseUrl: string): TurnLedger {
  ledgerUrls.set(ledger, databaseUrl);
  return ledger;
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
    ledger: tracked(ledger, databaseUrl),
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
  return tracked(ledger, databaseUrl);
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
    ...opts,
  });
  runner.start();
  after(() => runner.stopClaims());
  return runner;
}

export async function retryTurn(
  claimed: ClaimedTurn,
  { dueInMs = 0, stop = { kind: "error" } }: { dueInMs?: number; stop?: RunStop } = {},
): Promise<boolean> {
  const databaseUrl = ledgerUrls.get(claimed.ledger);
  if (!databaseUrl) throw new Error("retryTurn needs a ledger from testRunStore or appLedger");
  if (!(await claimed.ledger.retry(claimed.run, claimed.token, stop))) return false;
  await retryDue(databaseUrl, { taskId: claimed.run.absurdTaskId!, inMs: dueInMs });
  return true;
}
