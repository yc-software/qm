import type { AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import type { ErrorLog } from "../admin/error-log.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { TurnResult } from "../types.ts";
import type { Orchestrator, OrchestratorInput } from "../core/orchestrator.ts";
import { isNonRetryable, NonRetryableTurnError, ProviderTurnError, turnFailureMessage } from "../core/turn-error.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import {
  countedClaims,
  errorParks,
  handbackStop,
  MAX_PREEMPTIONS,
  PARKED,
  type Run,
  type RunStop,
  type RunStore,
} from "./run-store.ts";
import { errMessage, errorAlreadyReported, reportFailure, swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { retryDelay } from "./retry-delay.ts";
import { resolveSwarmSettings } from "../swarms/swarm-settings.ts";
import { traceQueued } from "../../plugins/chassis/src/error-reporting.ts";

export interface ProcessDeps {
  runs: RunStore;
  orchestrator: Orchestrator;
  leaseTtlMs: number;
  heartbeatIntervalMs?: number;
  errors?: ErrorLog;
}

export const LEASE_LOST_CONSECUTIVE = 3;

export const CLAIM_FAIL_REPORT_CONSECUTIVE = 20;
const SWARM_CLAIM_BUDGET = 3;

export async function processRun(
  deps: ProcessDeps,
  run: Run,
  opts?: { background?: boolean; shutdown?: AbortSignal },
): Promise<TurnResult> {
  const { trace, ...request } = run.request;
  return traceQueued(
    trace,
    "run",
    {
      "messaging.system": "qm",
      "messaging.destination.name": "runs",
      "messaging.message.id": run.id,
      "messaging.message.retry.count": Math.max(0, run.attempts - 1),
      "messaging.message.receive.latency":
        run.startedAt !== null ? Math.max(0, run.startedAt - run.createdAt) : undefined,
      "qm.surface": request.surface,
      "qm.origin": resolveTurnOrigin(request).kind,
    },
    () => attemptRun(deps, { ...run, request }, opts),
    (result) => opts?.shutdown?.aborted === true || result.stopped === true || result.status === "queued",
  );
}

async function attemptRun(
  deps: ProcessDeps,
  run: Run,
  opts?: { background?: boolean; shutdown?: AbortSignal },
): Promise<TurnResult> {
  const token = run.leaseToken;
  if (token === null) throw new Error(`processRun called with an unleased run ${run.id}`);
  const intervalMs = deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(deps.leaseTtlMs / 3));
  const cancel = new AbortController();
  const onShutdown = (): void => cancel.abort();
  if (opts?.shutdown?.aborted) onShutdown();
  else opts?.shutdown?.addEventListener("abort", onShutdown, { once: true });
  let workDeadline: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let consecutiveLost = 0;
  let leaseLost = false;
  const beat = setInterval(() => {
    void deps.runs
      .heartbeat(run.id, token, deps.leaseTtlMs)
      .then((alive) => {
        if (alive) {
          consecutiveLost = 0;
          return;
        }
        consecutiveLost += 1;
        if (consecutiveLost >= LEASE_LOST_CONSECUTIVE && !leaseLost) {
          leaseLost = true;
          clearInterval(beat);
          console.warn(
            `[worker] run ${run.id} lost its lease after ${consecutiveLost} consecutive beats; cancelling the in-process turn`,
          );
          cancel.abort();
        }
      })
      .catch((err: unknown) => {
        consecutiveLost = 0;
        console.warn(`[worker] heartbeat failed for run ${run.id} (transient, ignored): ${errMessage(err)}`);
      });
  }, intervalMs);
  let beatStopped = false;
  const stopBeat = (): void => {
    if (beatStopped) return;
    beatStopped = true;
    clearInterval(beat);
  };
  try {
    if (opts?.shutdown?.aborted) return { status: "queued", sessionId: run.sessionId, runId: run.id };
    workDeadline = swarmTurnLimits(run, cancel);
    started = true;
    const result = await deps.orchestrator.handleTurn(
      runTurnInput(run, {
        token,
        maxClaims: deps.runs.maxClaims,
        background: opts?.background ?? false,
        cancel: cancel.signal,
        ...(opts?.shutdown ? { shutdown: opts.shutdown } : {}),
      }),
    );
    stopBeat();
    if (opts?.shutdown?.aborted) return result;
    if (!(await deps.runs.complete(run.id, token, result))) {
      throw new Error(`run ${run.id} lost its lease before completion`);
    }
    return result;
  } catch (err) {
    stopBeat();
    if (opts?.shutdown?.aborted) throw err;
    recordTurnError(deps.errors, run, err);
    await deps.runs.fail(run.id, token, turnFailureMessage(err), {
      retry: !isNonRetryable(err),
      retryAfterMs: retryDelay(run.errorAttempts),
      stop: runStopFor(err),
    });
    throw err;
  } finally {
    clearTimeout(workDeadline);
    stopBeat();
    opts?.shutdown?.removeEventListener("abort", onShutdown);
    if (opts?.shutdown?.aborted)
      await deps.runs
        .releaseLease(run.id, token, started ? handbackStop(opts.shutdown) : undefined)
        .catch((e) => swallow(`worker: shutdown handback failed run=${run.id}; lease will expire after exit`, e));
  }
}

export function runTurnInput(
  run: Run,
  opts: {
    token: string;
    maxClaims: number | undefined;
    background: boolean;
    cancel: AbortSignal;
    shutdown?: AbortSignal;
    fenced?: boolean;
  },
): OrchestratorInput {
  return {
    ...run.request,
    origin: resolveTurnOrigin(run.request),
    runId: run.id,
    attempt: run.attempts,
    ...(run.lastStop ? { resumeCause: run.lastStop } : {}),
    runLeaseToken: opts.token,
    ...(opts.fenced ? { turnFenceToken: opts.token } : {}),
    finalAttempt: errorParks(run, opts.maxClaims),
    background: opts.background,
    cancel: opts.cancel,
    ...(opts.shutdown ? { shutdown: opts.shutdown } : {}),
    ...(run.startedAt !== null ? { runStartedAt: run.startedAt } : {}),
  };
}

export function swarmTurnLimits(
  run: Pick<Run, "request" | "attempts" | "preemptions">,
  cancel: AbortController,
): ReturnType<typeof setTimeout> | undefined {
  if (run.request.swarm && countedClaims(run) > SWARM_CLAIM_BUDGET)
    throw new NonRetryableTurnError("swarm claim budget exhausted");
  if (!run.request.swarm || run.request.swarmGoal) return undefined;
  const { turnMs } = resolveSwarmSettings({ turnMs: run.request.turnWallClockMs });
  return setTimeout(() => cancel.abort(), turnMs);
}

export function recordTurnError(errors: ErrorLog | undefined, run: Run, err: unknown): void {
  console.error(`[worker] run ${run.id} turn failed: ${errMessage(err)}`);
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

export interface WorkerDeps extends ProcessDeps {
  pollMs?: number;
  recoveryPollMs?: number;
  workerId?: string;
  canClaim?: () => boolean;
  admittedWork?: AdmittedWork;
}

export interface Worker {
  start(): void;
  held(): { run: Run; claimedAt: number; shutdown: AbortController } | null;
  preempt(runId: string): void;
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(drainMs?: number): Promise<void>;
  releaseInFlight(): Promise<void>;
}

const STOP_DRAIN_MS = 2_000;

export function createWorker(deps: WorkerDeps): Worker {
  const workerId = deps.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  const pollMs = deps.pollMs ?? 50;
  const recoveryPollMs = deps.recoveryPollMs ?? 5_000;
  const notifications = Boolean(deps.runs.subscribeAvailable);
  let generation = 0;
  let wake: (() => void) | null = null;
  let unsubscribe: (() => void) | undefined;
  const notify = (): void => {
    generation++;
    wake?.();
  };
  async function waitForWork(observed: number): Promise<void> {
    if (stopped || observed !== generation) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, notifications ? recoveryPollMs : pollMs);
      wake = done;
    });
  }
  let stopped = false;
  let loopDone: Promise<void> | null = null;
  let claimDone: Promise<void> | null = null;
  let inFlight: {
    run: Run;
    claimedAt: number;
    shutdown: AbortController;
    done: Promise<void>;
  } | null = null;

  async function loop(): Promise<void> {
    let claimFailures = 0;
    while (!stopped) {
      if (deps.canClaim && !deps.canClaim()) {
        await sleep(pollMs);
        continue;
      }
      const observed = generation;
      let run: Run | null;
      let claimed!: () => void;
      claimDone = new Promise<void>((resolve) => {
        claimed = resolve;
      });
      try {
        run = await deps.runs.claim(workerId, deps.leaseTtlMs);
        claimFailures = 0;
      } catch (e) {
        claimed();
        claimDone = null;
        claimFailures += 1;
        if (claimFailures === CLAIM_FAIL_REPORT_CONSECUTIVE) reportFailure("worker: persistent claim failure", e);
        swallow("worker: claim failed (transient, retrying)", e);
        await sleep(Math.min(pollMs * 2 ** Math.min(claimFailures, 5), 5_000));
        continue;
      }
      if (!run) {
        claimed();
        claimDone = null;
        await waitForWork(observed);
        continue;
      }
      if (stopped || (deps.canClaim && !deps.canClaim())) {
        if (run.leaseToken !== null)
          await deps.runs
            .releaseLease(run.id, run.leaseToken)
            .catch((e) => swallow("worker: post-stop claim handback failed", e));
        claimed();
        claimDone = null;
        break;
      }
      const shutdown = new AbortController();
      let settled!: () => void;
      const current: NonNullable<typeof inFlight> = {
        run,
        claimedAt: Date.now(),
        shutdown,
        done: new Promise<void>((resolve) => {
          settled = resolve;
        }),
      };
      inFlight = current;
      console.log(`[worker] claimed worker=${workerId} run=${run.id} thread=${run.sessionId}`);
      claimed();
      claimDone = null;
      try {
        const work = () => processRun(deps, run, { background: true, shutdown: shutdown.signal });
        if (deps.admittedWork) await deps.admittedWork.run(work);
        else await work();
      } catch (e) {
        if (!shutdown.signal.aborted) swallow("worker: background run crashed", e);
      } finally {
        if (shutdown.signal.aborted)
          console.log(`[worker] shutdown settled worker=${workerId} run=${run.id} thread=${run.sessionId}`);
        inFlight = null;
        settled();
      }
    }
  }

  function stopClaims(): Promise<void> {
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    notify();
    return claimDone ?? Promise.resolve();
  }

  return {
    held: () => inFlight,
    preempt(runId) {
      if (inFlight?.run.id !== runId || inFlight.shutdown.signal.aborted) return;
      inFlight.shutdown.abort(PARKED);
    },
    start() {
      if (loopDone) return;
      stopped = false;
      unsubscribe = deps.runs.subscribeAvailable?.(notify, {
        pollMs,
        onResync: notify,
      });
      loopDone = loop().finally(() => {
        loopDone = null;
      });
    },
    async releaseInFlight() {
      await stopClaims();
      const held = inFlight;
      if (!held) return;
      held.shutdown.abort();
      await held.done;
    },
    stopClaims,
    drained: () => loopDone ?? Promise.resolve(),
    async stop(drainMs = STOP_DRAIN_MS) {
      void stopClaims();
      await Promise.race([loopDone, sleep(drainMs, { unref: true })]);
    },
  };
}

export function runStopFor(err: unknown): RunStop {
  if (err instanceof ProviderTurnError)
    return { kind: "error", code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) };
  return { kind: "error" };
}

export function createRunPreemption(deps: {
  runs: RunStore;
  workers: readonly Worker[];
  canClaim?: () => boolean;
  graceMs?: number;
}): { sweep(): Promise<boolean> } {
  return {
    async sweep() {
      if (deps.canClaim && !deps.canClaim()) return false;
      const held = deps.workers.map((worker) => ({ worker, held: worker.held() }));
      if (held.some(({ held }) => !held || held.shutdown.signal.aborted)) return false;
      const victim = held
        .filter(({ held }) => held!.run.priority === 2 && held!.run.preemptions < MAX_PREEMPTIONS)
        .sort((a, b) => b.held!.claimedAt - a.held!.claimedAt)[0];
      if (!victim || !(await deps.runs.personWaiting(Date.now() - (deps.graceMs ?? 1_000)))) return false;
      victim.worker.preempt(victim.held!.run.id);
      return true;
    },
  };
}
