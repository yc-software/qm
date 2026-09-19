import { createHandoff, type Handoff, type HandoffSignals } from "./handoff.ts";
import type { AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import type { ErrorLog } from "../admin/error-log.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { TurnResult } from "../types.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import { NonRetryableTurnError, TurnHandedOff, turnFailureMessage } from "../core/turn-error.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { claimsSpent, errorParks, type Run, type RunStore } from "./run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { errMessage, errorAlreadyReported, swallow } from "../util/errors.ts";
import { sleep, withAbort, withOperationSignal } from "../util/async.ts";
import { retryDelay } from "./retry-delay.ts";
import { resolveSwarmSettings } from "../swarms/swarm-settings.ts";

export interface ProcessDeps {
  runs: RunStore;
  orchestrator: Orchestrator;
  leaseTtlMs: number;
  heartbeatIntervalMs?: number;
  errors?: ErrorLog;
  sessions?: SessionStore;
}

export const LEASE_LOST_CONSECUTIVE = 3;

const CLAIM_FAIL_CRASH_CONSECUTIVE = 20;

export async function processRun(
  deps: ProcessDeps,
  run: Run,
  opts?: { background?: boolean; handoff?: HandoffSignals },
): Promise<TurnResult> {
  const token = run.leaseToken;
  if (token === null) throw new Error(`processRun called with an unleased run ${run.id}`);
  const intervalMs = deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(deps.leaseTtlMs / 3));
  const cancel = new AbortController();
  let workDeadline: ReturnType<typeof setTimeout> | undefined;
  let consecutiveLost = 0;
  let leaseLost = false;
  let confirmedUntil = run.leaseExpiresAt ?? Date.now() + deps.leaseTtlMs;
  let leaseDeadline: ReturnType<typeof setTimeout> | undefined;
  const abortExpired = (): void => {
    if (leaseLost || Date.now() < confirmedUntil) return;
    leaseLost = true;
    clearInterval(beat);
    cancel.abort();
  };
  const scheduleLeaseDeadline = (): void => {
    clearTimeout(leaseDeadline);
    leaseDeadline = setTimeout(abortExpired, Math.max(0, confirmedUntil - Date.now()));
    leaseDeadline.unref?.();
  };
  scheduleLeaseDeadline();
  const beat = setInterval(() => {
    const heartbeatStarted = Date.now();
    void deps.runs
      .heartbeat(run.id, token, deps.leaseTtlMs)
      .then((alive) => {
        if (beatStopped || leaseLost) return;
        if (alive) {
          consecutiveLost = 0;
          confirmedUntil = Math.max(confirmedUntil, heartbeatStarted + deps.leaseTtlMs);
          scheduleLeaseDeadline();
          return;
        }
        consecutiveLost += 1;
        abortExpired();
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
        if (beatStopped || leaseLost) return;
        abortExpired();
        console.warn(`[worker] heartbeat failed for run ${run.id}: ${errMessage(err)}`);
      });
  }, intervalMs);
  let beatStopped = false;
  const stopBeat = (): void => {
    if (beatStopped) return;
    beatStopped = true;
    clearInterval(beat);
    clearTimeout(leaseDeadline);
  };
  try {
    if (run.request.swarm) {
      const { turnMs } = resolveSwarmSettings({ turnMs: run.request.turnWallClockMs });
      workDeadline = setTimeout(() => cancel.abort(), turnMs);
    }
    if (run.request.swarm && claimsSpent(run) > 3) throw new NonRetryableTurnError("swarm claim budget exhausted");
    const queueMs = run.startedAt !== null ? Math.max(0, run.startedAt - run.createdAt) : undefined;
    const result = await withAbort(
      () =>
        deps.orchestrator.handleTurn({
          ...run.request,
          origin: resolveTurnOrigin(run.request),
          runId: run.id,
          attempt: run.attempts,
          runLeaseToken: token,
          finalAttempt: errorParks(run, deps.runs.maxClaims),
          background: opts?.background ?? false,
          cancel: cancel.signal,
          ...(opts?.handoff ? { handoff: opts.handoff.requested, handoffDeadline: opts.handoff.deadline } : {}),
          ...(queueMs !== undefined ? { queueMs } : {}),
          ...(run.startedAt !== null ? { runStartedAt: run.startedAt } : {}),
        }),
      opts?.handoff?.deadline,
    );
    stopBeat();
    if (!(await deps.runs.complete(run.id, token, result))) {
      throw new Error(`run ${run.id} lost its lease before completion`);
    }
    return result;
  } catch (cause) {
    stopBeat();
    const deadlineReached = opts?.handoff?.deadline.aborted && cause === opts.handoff.deadline.reason;
    if (deadlineReached) cancel.abort();
    const err = deadlineReached ? new TurnHandedOff() : cause;
    if (err instanceof TurnHandedOff) {
      if (!deps.runs.backgroundOnly && deps.sessions) {
        const session = await deps.sessions.getByThread(run.sessionId);
        if (session && (await deps.sessions.peekLease(session.id))?.holder === "turn")
          await deps.sessions.forceReleaseLease(session.id);
      }
      if (!(await deps.runs.releaseLease(run.id, token, { handoff: true })))
        throw new Error(`run ${run.id} lost its lease before it could be handed off`, { cause });
      console.log(`[worker] run ${run.id} handed off to the incoming deployment at a committed step`);
      throw err;
    }
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
      ...(deps.runs.backgroundOnly ? {} : { retryAfterMs: retryDelay(run.errorAttempts) }),
    });
    throw err;
  } finally {
    clearTimeout(workDeadline);
    stopBeat();
  }
}

export interface WorkerDeps extends ProcessDeps {
  handoff?: Handoff;
  pollMs?: number;
  recoveryPollMs?: number;
  workerId?: string;
  sessions: SessionStore;
  canClaim?: () => boolean;
  onClaimed?: () => void;
  admittedWork?: AdmittedWork;
}

export interface Worker {
  start(): void;
  requestHandoff(graceMs: number): void;
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(drainMs?: number): Promise<void>;
  releaseInFlight(): Promise<void>;
  busy(): boolean;
}

const STOP_DRAIN_MS = 2_000;

export function createWorker(deps: WorkerDeps): Worker {
  let workerId = "";
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
  const handoff = deps.handoff ?? createHandoff();
  let surrendering: Promise<void> | undefined;
  let fencing: Promise<void> | undefined;
  const surrenderClaims = () => (surrendering ??= deps.runs.handoffWorker(workerId));

  async function loop(): Promise<void> {
    const signals = handoff.signals();
    let claimFailures = 0;
    try {
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
          run = await withAbort(
            () => withOperationSignal(signals.deadline, () => deps.runs.claim(workerId, deps.leaseTtlMs)),
            signals.deadline,
          );
          claimFailures = 0;
        } catch (e) {
          claimed();
          claimDone = null;
          if (signals.deadline.aborted) break;
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
              .releaseLease(run.id, run.leaseToken, { handoff: true })
              .catch((e) => swallow("worker: post-stop claim handback failed", e));
          claimed();
          claimDone = null;
          break;
        }
        inFlight =
          run.leaseToken !== null ? { runId: run.id, leaseToken: run.leaseToken, threadRef: run.sessionId } : null;
        claimed();
        claimDone = null;
        deps.onClaimed?.();
        try {
          const work = () => processRun(deps, run, { background: true, handoff: signals });
          if (deps.admittedWork) await deps.admittedWork.run(work);
          else await work();
        } catch (e) {
          if (!(e instanceof TurnHandedOff)) swallow("worker: background run crashed", e);
        } finally {
          inFlight = null;
        }
      }
    } finally {
      if (signals.requested.aborted) await surrenderClaims();
    }
  }

  function stopClaims(): Promise<void> {
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    notify();
    return claimDone ?? Promise.resolve();
  }

  function requestHandoff(graceMs: number): void {
    void stopClaims();
    fencing ??= deps.runs.handoffWorker(workerId, inFlight ? [inFlight.leaseToken] : []);
    void fencing.catch((error: unknown) => swallow("worker: claim fencing failed", error));
    handoff.request(graceMs);
  }

  return {
    start() {
      if (loopDone) return;
      stopped = false;
      workerId = `${deps.workerId ?? "w"}:${randomUUID()}`;
      surrendering = undefined;
      fencing = undefined;
      if (!deps.handoff) handoff.reset();
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
      if (!held) return handoff.signals().requested.aborted ? surrenderClaims() : Promise.resolve();
      if (held.leaseToken === releasedLeaseToken) return Promise.resolve();
      if (releasing) return releasing;
      releasing = (async () => {
        try {
          if (await deps.runs.heartbeat(held.runId, held.leaseToken, deps.leaseTtlMs)) {
            if (!deps.runs.backgroundOnly) {
              const session = await deps.sessions.getByThread(held.threadRef);
              if (session) await deps.sessions.forceReleaseLease(session.id);
            }
            await deps.runs.releaseLease(held.runId, held.leaseToken, { handoff: true });
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
    requestHandoff,
    drained: () => loopDone ?? Promise.resolve(),
    async stop(drainMs = STOP_DRAIN_MS) {
      void stopClaims();
      await Promise.race([loopDone, sleep(drainMs, { unref: true })]);
    },
  };
}
