import { randomUUID } from "node:crypto";
import type { TurnResult } from "../types.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { errorParks, type Run, type RunStore } from "./run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

export interface ProcessDeps {
  runs: RunStore;
  orchestrator: Orchestrator;
  leaseTtlMs: number;
  heartbeatIntervalMs?: number;
}

export const LEASE_LOST_CONSECUTIVE = 3;

const CLAIM_FAIL_CRASH_CONSECUTIVE = 20;

export async function processRun(deps: ProcessDeps, run: Run, opts?: { background?: boolean }): Promise<TurnResult> {
  const token = run.leaseToken;
  if (token === null) throw new Error(`processRun called with an unleased run ${run.id}`);
  const intervalMs = deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(deps.leaseTtlMs / 3));
  const cancel = new AbortController();
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
    const queueMs = run.startedAt !== null ? Math.max(0, run.startedAt - run.createdAt) : undefined;
    const result = await deps.orchestrator.handleTurn({
      ...run.request,
      origin: resolveTurnOrigin(run.request),
      runId: run.id,
      attempt: run.attempts,
      finalAttempt: errorParks(run, deps.runs.maxClaims),
      background: opts?.background ?? false,
      cancel: cancel.signal,
      ...(queueMs !== undefined ? { queueMs } : {}),
    });
    stopBeat();
    if (!(await deps.runs.complete(run.id, token, result))) {
      throw new Error(`run ${run.id} lost its lease before completion`);
    }
    return result;
  } catch (err) {
    stopBeat();
    await deps.runs.fail(run.id, token, errMessage(err), {
      retry: !(err instanceof NonRetryableTurnError),
    });
    throw err;
  } finally {
    stopBeat();
  }
}

export interface WorkerDeps extends ProcessDeps {
  pollMs?: number;
  workerId?: string;
  sessions: SessionStore;
  canClaim?: () => boolean;
  onClaimed?: () => void;
}

export interface Worker {
  start(): void;
  stop(drainMs?: number): Promise<void>;
  releaseInFlight(): Promise<void>;
  busy(): boolean;
}

const STOP_DRAIN_MS = 2_000;

export function createWorker(deps: WorkerDeps): Worker {
  const workerId = deps.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  const pollMs = deps.pollMs ?? 50;
  let stopped = false;
  let loopDone: Promise<void> | null = null;
  let inFlight: { runId: string; leaseToken: string; threadRef: string } | null = null;
  let releasedLeaseToken: string | null = null;
  let releasing: Promise<void> | null = null;

  async function loop(): Promise<void> {
    let claimFailures = 0;
    while (!stopped) {
      if (deps.canClaim && !deps.canClaim()) {
        await sleep(pollMs);
        continue;
      }
      let run: Run | null;
      try {
        run = await deps.runs.claim(workerId, deps.leaseTtlMs);
        claimFailures = 0;
      } catch (e) {
        claimFailures += 1;
        if (claimFailures >= CLAIM_FAIL_CRASH_CONSECUTIVE) throw e;
        swallow("worker: claim failed (transient, retrying)", e);
        await sleep(Math.min(pollMs * 2 ** Math.min(claimFailures, 5), 5_000));
        continue;
      }
      if (!run) {
        await sleep(pollMs);
        continue;
      }
      if (stopped) {
        if (run.leaseToken !== null)
          await deps.runs
            .releaseLease(run.id, run.leaseToken)
            .catch((e) => swallow("worker: post-stop claim handback failed", e));
        break;
      }
      inFlight =
        run.leaseToken !== null ? { runId: run.id, leaseToken: run.leaseToken, threadRef: run.sessionId } : null;
      deps.onClaimed?.();
      try {
        await processRun(deps, run, { background: true });
      } catch (e) {
        swallow("worker: background run crashed", e);
      } finally {
        inFlight = null;
      }
    }
  }

  return {
    start() {
      if (loopDone) return;
      stopped = false;
      loopDone = loop();
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
    async stop(drainMs = STOP_DRAIN_MS) {
      stopped = true;
      await Promise.race([loopDone, sleep(drainMs, { unref: true })]);
      loopDone = null;
    },
  };
}
