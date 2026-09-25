import type { AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import type { ErrorLog } from "../admin/error-log.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { TurnResult } from "../types.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import { NonRetryableTurnError, turnFailureMessage } from "../core/turn-error.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { errorParks, type Run, type RunStore } from "./run-store.ts";
import { errMessage, errorAlreadyReported, swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { retryDelay } from "./retry-delay.ts";
import { resolveSwarmSettings } from "../swarms/swarm-settings.ts";

export interface ProcessDeps {
  runs: RunStore;
  orchestrator: Orchestrator;
  leaseTtlMs: number;
  heartbeatIntervalMs?: number;
  errors?: ErrorLog;
}

export const LEASE_LOST_CONSECUTIVE = 3;

const CLAIM_FAIL_CRASH_CONSECUTIVE = 20;

export async function processRun(
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
    if (run.request.swarm) {
      const { turnMs } = resolveSwarmSettings({ turnMs: run.request.turnWallClockMs });
      workDeadline = setTimeout(() => cancel.abort(), turnMs);
    }
    if (run.request.swarm && run.attempts > 3) throw new NonRetryableTurnError("swarm claim budget exhausted");
    const queueMs = run.startedAt !== null ? Math.max(0, run.startedAt - run.createdAt) : undefined;
    const result = await deps.orchestrator.handleTurn({
      ...run.request,
      origin: resolveTurnOrigin(run.request),
      runId: run.id,
      attempt: run.attempts,
      runLeaseToken: token,
      finalAttempt: errorParks(run, deps.runs.maxClaims),
      background: opts?.background ?? false,
      cancel: cancel.signal,
      ...(queueMs !== undefined ? { queueMs } : {}),
      ...(run.startedAt !== null ? { runStartedAt: run.startedAt } : {}),
    });
    stopBeat();
    if (opts?.shutdown?.aborted) return result;
    if (!(await deps.runs.complete(run.id, token, result))) {
      throw new Error(`run ${run.id} lost its lease before completion`);
    }
    return result;
  } catch (err) {
    stopBeat();
    if (opts?.shutdown?.aborted) throw err;
    console.error(`[worker] run ${run.id} turn failed: ${errMessage(err)}`);
    if (!errorAlreadyReported(err))
      deps.errors?.record(
        {
          category: "turn",
          code: "error",
          message: `run ${run.id}: ${errMessage(err)}`,
          scopeLabel: conversationScope(run.request.conversation, run.request.actor.id),
        },
        err,
      );
    await deps.runs.fail(run.id, token, turnFailureMessage(err), {
      retry: !(err instanceof NonRetryableTurnError),
      retryAfterMs: retryDelay(run.errorAttempts),
    });
    throw err;
  } finally {
    clearTimeout(workDeadline);
    stopBeat();
    opts?.shutdown?.removeEventListener("abort", onShutdown);
    if (opts?.shutdown?.aborted)
      await deps.runs
        .releaseLease(run.id, token)
        .catch((e) => swallow(`worker: shutdown handback failed run=${run.id}; lease will expire after exit`, e));
  }
}

export interface WorkerDeps extends ProcessDeps {
  pollMs?: number;
  recoveryPollMs?: number;
  workerId?: string;
  canClaim?: () => boolean;
  onClaimed?: () => void;
  admittedWork?: AdmittedWork;
}

export interface Worker {
  start(): void;
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(drainMs?: number): Promise<void>;
  releaseInFlight(): Promise<void>;
  busy(): boolean;
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
  let inFlight: { shutdown: AbortController; done: Promise<void> } | null = null;

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
        if (claimFailures >= CLAIM_FAIL_CRASH_CONSECUTIVE) throw e;
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
      inFlight = {
        shutdown,
        done: new Promise<void>((resolve) => {
          settled = resolve;
        }),
      };
      console.log(`[worker] claimed worker=${workerId} run=${run.id} thread=${run.sessionId}`);
      claimed();
      claimDone = null;
      deps.onClaimed?.();
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
    busy() {
      return inFlight !== null;
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
