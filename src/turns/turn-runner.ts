import { randomUUID } from "node:crypto";
import type { ErrorLog } from "../admin/error-log.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import { isNonRetryable, NonRetryableTurnError, turnFailureMessage } from "../core/turn-error.ts";
import type { TurnResult } from "../types.ts";
import { sleep } from "../util/async.ts";
import { reportFailure, swallow } from "../util/errors.ts";
import type { EventBus } from "../util/event-bus.ts";
import { retryDelay } from "../runs/retry-delay.ts";
import {
  countedClaims,
  crashLoopReason,
  errorParks,
  stopErrorCode,
  type Run,
  type RunStop,
} from "../runs/run-store.ts";
import {
  CLAIM_FAIL_REPORT_CONSECUTIVE,
  LEASE_LOST_CONSECUTIVE,
  recordTurnError,
  runTurnInput,
  runStopFor,
  swarmTurnLimits,
} from "../runs/worker.ts";
import type { TurnQueue } from "./absurd-schema.ts";
import { TURN_EXTEND_INTERVAL_MS, type TurnLedger, type TurnOutcome } from "./turn-ledger.ts";

const CANCEL_GRACE_MS = 10_000;
const FALLBACK_POLL_MS = 1_000;
const HANDBACK_SETTLE_MS = 2_000;
const FINISH_RETRY_MAX_MS = 5_000;
const FINISH_RETRY_MS = 500;
const FAILURE_REPORT_CONSECUTIVE = 5;

export interface TurnRunnerDeps {
  ledger: TurnLedger;
  orchestrator: Orchestrator;
  queue: TurnQueue;
  slots: number;
  ready?: EventBus<string>;
  cancels?: EventBus<string>;
  canClaim?: () => boolean;
  errors?: ErrorLog;
  processId?: string;
  extendIntervalMs?: number;
  pollMs?: number;
  retryDelayMs?: (priorErrors: number) => number;
  maxClaims?: number;
}

interface HeldTurn {
  run: Run;
  token: string;
  cancel: AbortController;
  shutdown: AbortController;
  cancelled: boolean;
  done: Promise<void>;
  onCancel(): void;
}

export interface TurnRunner {
  start(): void;
  stopClaims(): Promise<void>;
  releaseInFlight(): Promise<void>;
  held(): readonly Run[];
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const processId = deps.processId ?? `h-${randomUUID().slice(0, 8)}`;
  const extendMs = deps.extendIntervalMs ?? TURN_EXTEND_INTERVAL_MS;
  const pollMs = deps.pollMs ?? FALLBACK_POLL_MS;
  const inFlight = new Map<string, HeldTurn>();
  let stopped = true;
  let loopDone: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let generation = 0;
  const unsubscribe: Array<() => void> = [];

  const notify = (): void => {
    generation++;
    wake?.();
  };

  async function waitForWork(observed: number): Promise<void> {
    if (stopped || observed !== generation) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function runTurn(held: HeldTurn): Promise<void> {
    const { run, token, cancel, shutdown } = held;
    const { trace: _trace, ...request } = run.request;
    let lost = false;
    let misses = 0;
    let extendFailures = 0;
    let workDeadline: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    held.onCancel = () => {
      if (held.cancelled) return;
      held.cancelled = true;
      cancelTimer = setTimeout(() => cancel.abort(), CANCEL_GRACE_MS);
      cancelTimer.unref?.();
    };
    const beat = setInterval(() => {
      void deps.ledger
        .extend(run, token)
        .then((outcome) => {
          extendFailures = 0;
          if (outcome === "held") {
            misses = 0;
            return;
          }
          if (outcome === "cancelled") {
            held.onCancel();
            return;
          }
          misses += 1;
          if (misses >= LEASE_LOST_CONSECUTIVE && !lost) {
            lost = true;
            console.warn(`[turns] turn ${run.id} lost its claim; cancelling the in-process turn`);
            cancel.abort();
          }
        })
        .catch((error: unknown) => {
          extendFailures += 1;
          if (extendFailures === FAILURE_REPORT_CONSECUTIVE)
            reportFailure(`turns: claim extension keeps failing for turn ${run.id}`, error);
          else swallow(`turns: extend failed for turn ${run.id} (transient)`, error);
        });
    }, extendMs);
    beat.unref?.();
    const finishWith = async (outcome: TurnOutcome): Promise<void> => {
      for (let attempt = 1; !shutdown.signal.aborted; attempt++) {
        try {
          if (!(await deps.ledger.finish(run, token, outcome)))
            console.warn(`[turns] turn ${run.id} ended after losing its claim; its result was not recorded`);
          return;
        } catch (error) {
          if (attempt === FAILURE_REPORT_CONSECUTIVE)
            reportFailure(`turns: turn end keeps failing for turn ${run.id}`, error);
          else swallow(`turns: turn end failed for turn ${run.id} (retrying)`, error);
          await sleep(Math.min(FINISH_RETRY_MS * attempt, FINISH_RETRY_MAX_MS));
        }
      }
    };
    let ended: { kind: "result"; result: TurnResult } | { kind: "error"; err: unknown };
    try {
      workDeadline = swarmTurnLimits(run, cancel);
      if (deps.maxClaims !== undefined && countedClaims(run) > deps.maxClaims)
        throw new NonRetryableTurnError(crashLoopReason(countedClaims(run) - 1));
      ended = {
        kind: "result",
        result: await deps.orchestrator.handleTurn(
          runTurnInput(
            { ...run, request },
            {
              token,
              maxClaims: deps.maxClaims,
              background: true,
              cancel: cancel.signal,
              shutdown: shutdown.signal,
              fenced: true,
            },
          ),
        ),
      };
    } catch (err) {
      ended = { kind: "error", err };
    }
    try {
      if (shutdown.signal.aborted || lost) {
        if (ended.kind === "error")
          swallow(`turns: turn ${run.id} ended after ${lost ? "losing its claim" : "handback"}`, ended.err);
        return;
      }
      if (ended.kind === "result") {
        await finishWith({
          status: "done",
          result: held.cancelled ? { ...ended.result, stopped: true } : ended.result,
        });
        return;
      }
      if (held.cancelled) {
        await finishWith({ status: "done", result: { status: "ok", sessionId: run.sessionId, stopped: true } });
        return;
      }
      recordTurnError(deps.errors, run, ended.err);
      const stop = runStopFor(ended.err);
      if (isNonRetryable(ended.err) || errorParks(run, deps.maxClaims))
        await finishWith({
          status: "failed",
          countsAsError: true,
          result: {
            status: "failed",
            sessionId: run.sessionId,
            reason: turnFailureMessage(ended.err),
            ...stopErrorCode(stop),
          },
        });
      else if (
        !(await deps.ledger.handBack(run, token, {
          stop,
          delayMs: (deps.retryDelayMs ?? retryDelay)(run.errorAttempts),
          countsAsError: true,
        }))
      )
        console.warn(`[turns] turn ${run.id} could not be requeued after an error; its claim was already gone`);
    } finally {
      clearInterval(beat);
      clearTimeout(workDeadline);
      clearTimeout(cancelTimer);
    }
  }

  function launch(run: Run, token: string): void {
    let settle!: () => void;
    const held: HeldTurn = {
      run,
      token,
      cancel: new AbortController(),
      shutdown: new AbortController(),
      cancelled: false,
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      onCancel: () => {
        held.cancelled = true;
      },
    };
    inFlight.set(run.id, held);
    console.log(`[turns] claimed process=${processId} turn=${run.id} thread=${run.sessionId} attempt=${run.attempts}`);
    void runTurn(held)
      .catch((error: unknown) => swallow(`turns: turn ${run.id} crashed`, error))
      .finally(() => {
        inFlight.delete(run.id);
        settle();
        notify();
      });
  }

  async function loop(): Promise<void> {
    let failures = 0;
    while (!stopped) {
      const observed = generation;
      if (deps.canClaim && !deps.canClaim()) {
        await sleep(pollMs);
        continue;
      }
      try {
        while (!stopped && inFlight.size < deps.slots && (!deps.canClaim || deps.canClaim())) {
          const token = `${processId}:${randomUUID()}`;
          const { claimed, run } = await deps.ledger.claim(deps.queue, token, processId);
          if (!claimed) break;
          if (run) {
            if (stopped || (deps.canClaim && !deps.canClaim()))
              await deps.ledger.handBack(run, token, { unstarted: true });
            else launch(run, token);
          }
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures === CLAIM_FAIL_REPORT_CONSECUTIVE) reportFailure("turns: persistent claim failure", error);
        swallow("turns: claim failed (transient, retrying)", error);
        await sleep(Math.min(pollMs * 2 ** Math.min(failures, 5), 5_000));
        continue;
      }
      await waitForWork(observed);
    }
  }

  async function stopClaims(): Promise<void> {
    stopped = true;
    for (const off of unsubscribe.splice(0)) off();
    notify();
    await loopDone;
  }

  return {
    start() {
      if (loopDone) return;
      stopped = false;
      if (deps.ready) unsubscribe.push(deps.ready.subscribe(notify, { onResync: notify }));
      if (deps.cancels)
        unsubscribe.push(
          deps.cancels.subscribe((turnId) => {
            inFlight.get(turnId)?.onCancel();
          }),
        );
      loopDone = loop().finally(() => {
        loopDone = null;
      });
    },
    stopClaims,
    async releaseInFlight() {
      await stopClaims();
      const held = [...inFlight.values()];
      await Promise.all(
        held.map(async (turn) => {
          turn.shutdown.abort();
          turn.cancel.abort();
          const stop: RunStop = { kind: "shutdown" };
          await deps.ledger
            .handBack(turn.run, turn.token, { stop })
            .catch((error: unknown) =>
              swallow(`turns: shutdown handback failed turn=${turn.run.id}; the claim will expire`, error),
            );
        }),
      );
      await Promise.race([Promise.all(held.map((turn) => turn.done)), sleep(HANDBACK_SETTLE_MS, { unref: true })]);
    },
    held: () => [...inFlight.values()].map((turn) => turn.run),
  };
}
