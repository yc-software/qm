import { randomUUID } from "node:crypto";
import type { ErrorLog } from "../admin/error-log.ts";
import type { Orchestrator, OrchestratorInput } from "../core/orchestrator.ts";
import { isNonRetryable, NonRetryableTurnError, ProviderTurnError, turnFailureMessage } from "../core/turn-error.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { TurnResult } from "../types.ts";
import { sleep } from "../util/async.ts";
import { errMessage, errorAlreadyReported, reportFailure, swallow } from "../util/errors.ts";
import type { EventBus } from "../util/event-bus.ts";
import { retryDelay } from "../runs/retry-delay.ts";
import {
  countedClaims,
  crashLoopReason,
  errorParks,
  MAX_PREEMPTIONS,
  PARKED,
  stopErrorCode,
  type Run,
  type RunStop,
} from "../runs/run-store.ts";
import type { TurnQueue } from "./absurd-schema.ts";
import { holdTenant, withoutTenant, withTenant, type Tenant } from "../tenant.ts";
import { pgTenancyEnabled } from "../persistence/pg-pool.ts";
import { TURN_EXTEND_INTERVAL_MS, type TurnLedger, type TurnOutcome } from "./turn-ledger.ts";

const CANCEL_GRACE_MS = 10_000;
const FALLBACK_POLL_MS = 1_000;
const HANDBACK_SETTLE_MS = 2_000;
const FINISH_RETRY_MAX_MS = 5_000;
const FINISH_RETRY_MS = 500;
const FAILURE_REPORT_CONSECUTIVE = 5;
const CLAIM_FAIL_REPORT_CONSECUTIVE = 20;
const TENANT_BUSY_DEFER_MS = 10_000;
const LEASE_LOST_CONSECUTIVE = 3;
export const RUN_MAX_CLAIMS = 8;

function runTurnInput(
  run: Run,
  opts: { token: string; maxClaims: number | undefined; cancel: AbortSignal; shutdown: AbortSignal },
): OrchestratorInput {
  return {
    ...run.request,
    origin: run.request.origin,
    runId: run.id,
    attempt: run.attempts,
    ...(run.lastStop ? { resumeCause: run.lastStop } : {}),
    runLeaseToken: opts.token,
    turnFenceToken: opts.token,
    finalAttempt: errorParks(run, opts.maxClaims),
    background: true,
    cancel: opts.cancel,
    shutdown: opts.shutdown,
    ...(run.startedAt !== null ? { runStartedAt: run.startedAt } : {}),
  };
}

function recordTurnError(errors: ErrorLog | undefined, run: Run, err: unknown): void {
  console.error(`[turns] turn ${run.id} failed: ${errMessage(err)}`);
  if (!errorAlreadyReported(err))
    errors?.record(
      {
        category: "turn",
        code: "error",
        message: `run ${run.id}: ${errMessage(err)}`,
        scopeLabel: conversationScope(run.request.conversation, run.request.actor.id),
      },
      err,
    );
}

function runStopFor(err: unknown): RunStop {
  if (err instanceof ProviderTurnError)
    return { kind: "error", code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) };
  return { kind: "error" };
}

export interface TurnRunnerDeps {
  ledger: TurnLedger;
  orchestrator: Orchestrator;
  queues: readonly TurnQueue[];
  slots: number;
  capacity?: () => number;
  ready?: EventBus<string>;
  cancels?: EventBus<string>;
  yields?: EventBus<string>;
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
  tenant: Tenant;
  token: string;
  cancel: AbortController;
  shutdown: AbortController;
  cancelled: boolean;
  yielding: boolean;
  done: Promise<void>;
  onCancel(): void;
}

export interface TurnRunner {
  start(): void;
  stopClaims(): Promise<void>;
  releaseInFlight(): Promise<void>;
  held(): readonly Run[];
}

async function yieldHeld(deps: TurnRunnerDeps, held: HeldTurn, reason: "capacity" | "person"): Promise<void> {
  if (held.yielding) return;
  held.yielding = true;
  held.shutdown.abort(PARKED);
  held.cancel.abort();
  let outcome: "yielded" | "handed_back" | "lost" | "stopped" | "failed";
  try {
    if (reason === "person") outcome = await deps.ledger.yieldTo(held.run, held.token);
    else outcome = (await deps.ledger.handBack(held.run, held.token, { stop: PARKED })) ? "handed_back" : "lost";
  } catch (error) {
    reportFailure(`turns: parking failed turn=${held.run.id} reason=${reason}; handing the turn back`, error);
    outcome = await deps.ledger
      .handBack(held.run, held.token, { stop: PARKED })
      .then((ok) => (ok ? "handed_back" : "lost"))
      .catch((fallback: unknown) => {
        reportFailure(
          `turns: handback after a failed park failed turn=${held.run.id}; the claim will expire`,
          fallback,
        );
        return "failed" as const;
      });
  }
  if (outcome === "lost") {
    const stopped = await deps.ledger
      .finish(held.run, held.token, {
        status: "done",
        result: { status: "ok", sessionId: held.run.sessionId, stopped: true },
      })
      .catch((error: unknown) => {
        reportFailure(`turns: ending a stopped turn failed turn=${held.run.id}; repair will clean it up`, error);
        return false;
      });
    if (stopped) outcome = "stopped";
  }
  console.log(`[turns] parked turn=${held.run.id} reason=${reason} outcome=${outcome}`);
}

async function runTurn(deps: TurnRunnerDeps, held: HeldTurn): Promise<void> {
  const extendMs = deps.extendIntervalMs ?? TURN_EXTEND_INTERVAL_MS;
  const { run, token, cancel, shutdown } = held;
  const { trace: _trace, ...request } = run.request;
  let lost = false;
  let misses = 0;
  let extendFailures = 0;
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
          if (run.priority === 2 && !held.yielding)
            void deps.ledger
              .mustYield(run)
              .then((waiting) => (waiting ? yieldHeld(deps, held, "person") : undefined))
              .catch((error: unknown) => swallow(`turns: yield check failed turn=${run.id}`, error));
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
    for (let attempt = 1; !shutdown.signal.aborted && !lost; attempt++) {
      try {
        if (!(await deps.ledger.finish(run, token, outcome)))
          console.warn(`[turns] turn ${run.id} ended after losing its claim; its result was not recorded`);
        return;
      } catch (error) {
        if (attempt % FAILURE_REPORT_CONSECUTIVE === 0)
          reportFailure(`turns: turn end keeps failing for turn ${run.id} (attempt ${attempt})`, error);
        else swallow(`turns: turn end failed for turn ${run.id} (retrying)`, error);
        await sleep(Math.min(FINISH_RETRY_MS * attempt, FINISH_RETRY_MAX_MS));
      }
    }
    console.warn(
      `[turns] turn ${run.id} ended after ${lost ? "losing its claim" : "shutdown"}; its result was not recorded`,
    );
  };
  let ended: { kind: "result"; result: TurnResult } | { kind: "error"; err: unknown };
  try {
    if (run.priority === 2 && (await deps.ledger.mustYield(run))) {
      clearInterval(beat);
      await yieldHeld(deps, held, "person");
      return;
    }
    if (deps.maxClaims !== undefined && countedClaims(run) > deps.maxClaims)
      throw new NonRetryableTurnError(crashLoopReason(countedClaims(run) - 1));
    ended = {
      kind: "result",
      result: await deps.orchestrator.handleTurn(
        runTurnInput(
          { ...run, request },
          { token, maxClaims: deps.maxClaims, cancel: cancel.signal, shutdown: shutdown.signal },
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
    held.yielding = true;
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
    clearTimeout(cancelTimer);
  }
}

function parkForCapacity(deps: TurnRunnerDeps, inFlight: ReadonlyMap<string, HeldTurn>): void {
  const victim = [...inFlight.values()]
    .filter(
      (held) =>
        held.run.absurdQueue === "turns_background" &&
        held.run.preemptions < MAX_PREEMPTIONS &&
        !held.yielding &&
        !held.shutdown.signal.aborted,
    )
    .at(-1);
  if (victim)
    void withTenant(victim.tenant, () => yieldHeld(deps, victim, "capacity")).catch((error: unknown) =>
      swallow(`turns: capacity parking failed turn=${victim.run.id}`, error),
    );
}

async function handBackAll(deps: TurnRunnerDeps, held: readonly HeldTurn[]): Promise<void> {
  await Promise.all(
    held.map(async (turn) => {
      turn.shutdown.abort();
      turn.cancel.abort();
      const stop: RunStop = { kind: "shutdown" };
      await withTenant(turn.tenant, () => deps.ledger.handBack(turn.run, turn.token, { stop })).catch(
        (error: unknown) =>
          swallow(`turns: shutdown handback failed turn=${turn.run.id}; the claim will expire`, error),
      );
    }),
  );
  await Promise.race([Promise.all(held.map((turn) => turn.done)), sleep(HANDBACK_SETTLE_MS, { unref: true })]);
}

function tenantBusy(inFlight: ReadonlyMap<string, HeldTurn>, slots: number, queue: TurnQueue, t: Tenant): boolean {
  if (queue === "turns_people" || !pgTenancyEnabled()) return false;
  let held = 0;
  for (const turn of inFlight.values()) if (turn.run.absurdQueue !== "turns_people" && turn.tenant.id === t.id) held++;
  return held >= Math.max(1, Math.floor(slots / 2));
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const processId = deps.processId ?? `h-${randomUUID().slice(0, 8)}`;
  const pollMs = deps.pollMs ?? FALLBACK_POLL_MS;
  const inFlight = new Map<string, HeldTurn>();
  const overcommit = Math.max(1, Math.floor(deps.slots / 4));
  const capacity = (): number => Math.min(deps.slots, deps.capacity?.() ?? deps.slots);
  const mayClaim = (): boolean => !stopped && (!deps.canClaim || deps.canClaim());

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

  function launch(run: Run, token: string, tenant: Tenant): void {
    let settle!: () => void;
    const held: HeldTurn = {
      run,
      tenant,
      token,
      cancel: new AbortController(),
      shutdown: new AbortController(),
      cancelled: false,
      yielding: false,
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      onCancel: () => {
        held.cancelled = true;
      },
    };
    inFlight.set(run.id, held);
    const release = holdTenant(tenant);
    console.log(`[turns] claimed process=${processId} turn=${run.id} thread=${run.sessionId} attempt=${run.attempts}`);
    void withTenant(tenant, () => runTurn(deps, held))
      .catch((error: unknown) => swallow(`turns: turn ${run.id} crashed`, error))
      .finally(() => {
        inFlight.delete(run.id);
        release();
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
        for (const queue of deps.queues) {
          let deferred = 0;
          while (mayClaim()) {
            const limit = capacity();
            const people = queue === "turns_people";
            if (inFlight.size >= limit + (people ? overcommit : 0)) break;
            const token = `${processId}:${randomUUID()}`;
            const claim = await deps.ledger.claim(queue, token, processId);
            if (!claim.claimed) break;
            if (!claim.run) continue;
            const { run, tenant } = claim;
            if (!mayClaim()) {
              await withTenant(tenant, () => deps.ledger.handBack(run, token, { unstarted: true }));
              break;
            }
            if (tenantBusy(inFlight, deps.slots, queue, tenant)) {
              const later = { unstarted: true, delayMs: TENANT_BUSY_DEFER_MS };
              await withTenant(tenant, () => deps.ledger.handBack(run, token, later));
              if (++deferred >= limit) break;
              continue;
            }
            launch(run, token, tenant);
            if (people && inFlight.size > limit) parkForCapacity(deps, inFlight);
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
      withoutTenant(() => {
        stopped = false;
        if (deps.ready) unsubscribe.push(deps.ready.subscribe(notify, { onResync: notify }));
        if (deps.cancels)
          unsubscribe.push(
            deps.cancels.subscribe((turnId) => {
              inFlight.get(turnId)?.onCancel();
            }),
          );
        if (deps.yields)
          unsubscribe.push(
            deps.yields.subscribe((turnId) => {
              const held = inFlight.get(turnId);
              if (held?.run.priority === 2)
                void withTenant(held.tenant, () => yieldHeld(deps, held, "person")).catch((error: unknown) =>
                  swallow(`turns: yield to a person failed turn=${turnId}`, error),
                );
            }),
          );
        loopDone = loop().finally(() => {
          loopDone = null;
        });
      });
    },
    stopClaims,
    async releaseInFlight() {
      await stopClaims();
      await handBackAll(deps, [...inFlight.values()]);
    },
    held: () => [...inFlight.values()].map((turn) => turn.run),
  };
}
