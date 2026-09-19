import type { AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import timers from "node:timers/promises";
import type { ErrorLog } from "../admin/error-log.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { scopeId, type TurnResult } from "../types.ts";
import { orgId } from "../config.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import { NonRetryableTurnError, turnFailureMessage } from "../core/turn-error.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { errorParks, type Run, type RunStore } from "./run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { errMessage, errorAlreadyReported, swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { retryDelay } from "./retry-delay.ts";
import { resolveSwarmSettings } from "../swarms/swarm-settings.ts";
import type { WorkCapacity } from "./work-capacity.ts";

export interface ProcessDeps {
  runs: RunStore;
  orchestrator: Orchestrator;
  leaseTtlMs: number;
  heartbeatIntervalMs?: number;
  errors?: ErrorLog;
}

export const LEASE_LOST_CONSECUTIVE = 3;

const CLAIM_FAIL_CRASH_CONSECUTIVE = 20;

export async function processRun(deps: ProcessDeps, run: Run, opts?: { background?: boolean }): Promise<TurnResult> {
  const token = run.leaseToken;
  if (token === null) throw new Error(`processRun called with an unleased run ${run.id}`);
  const intervalMs = deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(deps.leaseTtlMs / 3));
  const cancel = new AbortController();
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
    if (!(await deps.runs.complete(run.id, token, result))) {
      throw new Error(`run ${run.id} lost its lease before completion`);
    }
    return result;
  } catch (err) {
    stopBeat();
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
  }
}

export interface WorkerDeps extends ProcessDeps {
  pollMs?: number;
  recoveryPollMs?: number;
  workerId?: string;
  sessions: SessionStore;
  canClaim?: () => boolean;
  onClaimed?: () => void;
  admittedWork?: AdmittedWork;
  capacity?: WorkCapacity;
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
  const failureScope = scopeId("org", orgId());
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
  let inFlight: { runId: string; leaseToken: string; threadRef: string } | null = null;
  let releasedLeaseToken: string | null = null;
  let releasing: Promise<void> | null = null;
  let claimsAbort = new AbortController();

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
      let release: (() => void) | null = null;
      try {
        if (deps.capacity) {
          release = await deps.capacity.acquire(claimsAbort.signal);
          if (!release || stopped) break;
          if (deps.canClaim && !deps.canClaim()) continue;
        }
        try {
          run = await deps.runs.claim(workerId, deps.leaseTtlMs);
          claimFailures = 0;
        } catch (e) {
          claimed();
          claimDone = null;
          release?.();
          claimFailures += 1;
          if (!deps.capacity && claimFailures >= CLAIM_FAIL_CRASH_CONSECUTIVE) throw e;
          if (!deps.capacity || claimFailures === 1 || claimFailures % CLAIM_FAIL_CRASH_CONSECUTIVE === 0) {
            swallow("worker: claim failed (transient, retrying)", e);
            deps.errors?.record(
              {
                category: "runtime",
                code: "worker_claim_failed",
                message: `worker ${workerId} failed to claim work ${claimFailures} consecutive times: ${errMessage(e)}`,
                scopeLabel: failureScope,
              },
              e,
            );
          }
          const retryMs = Math.min(
            (deps.capacity ? Math.max(250, pollMs) : pollMs) * 2 ** Math.min(claimFailures, 5),
            5_000,
          );
          await timers.setTimeout(retryMs, undefined, { signal: claimsAbort.signal }).catch((error: unknown) => {
            if (!claimsAbort.signal.aborted) throw error;
          });
          continue;
        }
        if (!run) {
          claimed();
          claimDone = null;
          release?.();
          await waitForWork(observed);
          continue;
        }
        if (stopped || (deps.canClaim && !deps.canClaim())) {
          if (run.leaseToken !== null)
            await deps.runs
              .releaseLease(run.id, run.leaseToken)
              .catch((e) => swallow("worker: post-stop claim handback failed", e));
          break;
        }
        inFlight =
          run.leaseToken !== null ? { runId: run.id, leaseToken: run.leaseToken, threadRef: run.sessionId } : null;
        claimed();
        claimDone = null;
        deps.onClaimed?.();
        try {
          const claimedRun = run;
          const work = () => processRun(deps, claimedRun, { background: true });
          if (deps.admittedWork) await deps.admittedWork.run(work);
          else await work();
        } catch (e) {
          swallow("worker: background run crashed", e);
        }
      } finally {
        claimed();
        claimDone = null;
        release?.();
        inFlight = null;
      }
    }
  }

  function stopClaims(): Promise<void> {
    stopped = true;
    claimsAbort.abort();
    unsubscribe?.();
    unsubscribe = undefined;
    notify();
    return claimDone ?? Promise.resolve();
  }

  return {
    start() {
      if (loopDone) return;
      stopped = false;
      claimsAbort = new AbortController();
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
    releaseInFlight() {
      const held = inFlight;
      if (!held || held.leaseToken === releasedLeaseToken) return Promise.resolve();
      if (releasing) return releasing;
      releasing = (async () => {
        try {
          if (await deps.runs.heartbeat(held.runId, held.leaseToken, deps.leaseTtlMs)) {
            const session = await deps.sessions.getByThread(held.threadRef);
            if (session) await deps.sessions.forceReleaseLease(session.id);
            await deps.runs.releaseLease(held.runId, held.leaseToken);
          }
          releasedLeaseToken = held.leaseToken;
        } catch (e) {
          swallow("worker: releaseInFlight failed", e);
        } finally {
          releasing = null;
        }
      })();
      return releasing;
    },
    stopClaims,
    drained: () => loopDone ?? Promise.resolve(),
    async stop(drainMs = STOP_DRAIN_MS) {
      void stopClaims();
      await Promise.race([loopDone, sleep(drainMs, { unref: true })]);
    },
  };
}
