import type { AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import type { ErrorLog } from "../admin/error-log.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { TurnResult } from "../types.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import {
  HeldTurnError,
  isNonRetryable,
  NonRetryableTurnError,
  ProviderTurnError,
  turnFailureMessage,
} from "../core/turn-error.ts";
import {
  countedClaims,
  CRASHED,
  errorParks,
  handbackStop,
  MAX_PREEMPTIONS,
  PARKED,
  type TurnPark,
  type Run,
  type RunStop,
  type RunStore,
} from "./run-store.ts";
import { errMessage, errorAlreadyReported, reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { retryDelay } from "./retry-delay.ts";
import { FLUSH_MS, traceQueued } from "../../plugins/chassis/src/error-reporting.ts";
import { type Tenant, withTenant } from "../tenants/context.ts";

export interface ProcessDeps {
  runs: RunStore;
  orchestrator: Orchestrator;
  leaseTtlMs: number;
  heartbeatIntervalMs?: number;
  errors?: ErrorLog;
}

export const LEASE_LOST_CONSECUTIVE = 3;

export const SHUTDOWN_SETTLE_MS = 5_000;

const SHUTDOWN_HANDBACK_MS = 3_000;

export const SHUTDOWN_RELEASE_MS = SHUTDOWN_SETTLE_MS + SHUTDOWN_HANDBACK_MS;

export const SHUTDOWN_EXIT_MS = SHUTDOWN_RELEASE_MS + SHUTDOWN_HANDBACK_MS + FLUSH_MS;

const CLAIM_FAIL_REPORT_CONSECUTIVE = 20;

export async function processRun(
  deps: ProcessDeps,
  run: Run,
  opts?: { shutdown?: AbortSignal; park?: TurnPark },
): Promise<TurnResult> {
  const { trace, ...request } = run.request;
  return withTenant(run.tenantId, (tenant) =>
    traceQueued(
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
        "qm.origin": "origin" in request ? request.origin.kind : undefined,
      },
      () => attemptRun(tenant, deps, { ...run, request }, opts),
      (result) => opts?.shutdown?.aborted === true || result.stopped === true || result.status === "queued",
    ),
  );
}

async function attemptRun(
  tenant: Tenant,
  deps: ProcessDeps,
  run: Run,
  opts?: { shutdown?: AbortSignal; park?: TurnPark },
): Promise<TurnResult> {
  const token = run.leaseToken;
  if (token === null) throw new Error(`processRun called with an unleased run ${run.id}`);
  const intervalMs = deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(deps.leaseTtlMs / 3));
  const cancel = new AbortController();
  let stranded = false;
  let strandTimer: ReturnType<typeof setTimeout> | undefined;
  const strand = Promise.withResolvers<TurnResult>();
  const shutdown = opts?.shutdown;
  const onShutdown = (): void => {
    cancel.abort();
    if (!shutdown || handbackStop(shutdown).kind !== "shutdown") return;
    strandTimer = setTimeout(() => {
      stranded = true;
      strand.resolve({ status: "queued", sessionId: run.sessionId, runId: run.id });
    }, SHUTDOWN_SETTLE_MS);
  };
  if (opts?.shutdown?.aborted) onShutdown();
  else opts?.shutdown?.addEventListener("abort", onShutdown, { once: true });
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
    if (run.request.swarm && countedClaims(run) > 3) throw new NonRetryableTurnError("swarm claim budget exhausted");
    if (!("origin" in run.request)) throw new NonRetryableTurnError("stored run request has no origin");
    started = true;
    const turn = deps.orchestrator.handleTurn({
      ...run.request,
      runId: run.id,
      attempt: run.attempts,
      ...(run.lastStop ? { resumeCause: run.lastStop } : {}),
      runLeaseToken: token,
      finalAttempt: errorParks(run, deps.runs.maxClaims),
      cancel: cancel.signal,
      ...(opts?.shutdown ? { shutdown: opts.shutdown } : {}),
      ...(opts?.park ? { park: opts.park } : {}),
      ...(run.startedAt !== null ? { runStartedAt: run.startedAt } : {}),
    });
    const result = await Promise.race([turn, strand.promise]);
    clearTimeout(strandTimer);
    shutdown?.removeEventListener("abort", onShutdown);
    if (stranded) turn.catch((e: unknown) => swallow(`worker: stranded run=${run.id} failed after hand-back`, e));
    stopBeat();
    if (opts?.shutdown?.aborted) return result;
    if (!(await deps.runs.complete(run.id, token, result))) {
      throw new Error(`run ${run.id} lost its lease before completion`);
    }
    return result;
  } catch (err) {
    stopBeat();
    if (opts?.shutdown?.aborted) throw err;
    if (err instanceof HeldTurnError) {
      console.warn(`[worker] run ${run.id} held: ${err.message}`);
      if (!(await deps.runs.releaseLease(run.id, token, undefined, Date.now() + err.retryAfterMs)))
        throw new Error(`run ${run.id} lost its lease before it could be held`, { cause: err });
      return { status: "queued", sessionId: run.sessionId, runId: run.id };
    }
    console.error(`[worker] run ${run.id} turn failed: ${errMessage(err)}`);
    if (!errorAlreadyReported(err))
      deps.errors?.record(
        tenant,
        {
          category: "turn",
          code: "error",
          message: `run ${run.id}: ${errMessage(err)}`,
          scopeLabel: conversationScope(run.request.conversation, run.request.actor.id),
        },
        err,
      );
    await deps.runs.fail(run.id, token, turnFailureMessage(err), {
      retry: !isNonRetryable(err),
      retryAfterMs: retryDelay(run.errorAttempts),
      stop: runStopFor(err),
    });
    throw err;
  } finally {
    stopBeat();
    clearTimeout(strandTimer);
    opts?.shutdown?.removeEventListener("abort", onShutdown);
    if (shutdown?.reason === CRASHED)
      console.warn(`[worker] run ${run.id} held by a crashing process; leaving its lease to expire`);
    else if (shutdown?.aborted)
      await handBack(deps, run, token, started ? handbackStop(shutdown) : undefined, stranded).catch((e) =>
        swallow(`worker: shutdown handback failed run=${run.id}; lease will expire after exit`, e),
      );
  }
}

async function handBack(
  deps: ProcessDeps,
  run: Run,
  token: string,
  stop: RunStop | undefined,
  stranded: boolean,
): Promise<void> {
  if (!stranded) {
    await deps.runs.releaseLease(run.id, token, stop);
    return;
  }
  const exited = Date.now() + SHUTDOWN_EXIT_MS;
  if (!(await deps.runs.heartbeat(run.id, token, deps.leaseTtlMs))) {
    console.warn(`[worker] run ${run.id} ignored shutdown and is no longer held here; leaving it to its owner`);
    return;
  }
  console.warn(`[worker] run ${run.id} ignored shutdown; handing it back to resume after this process exits`);
  await deps.runs.releaseLease(run.id, token, stop, exited);
}

export interface WorkerDeps extends ProcessDeps {
  slots?: number;
  pollMs?: number;
  recoveryPollMs?: number;
  workerId?: string;
  canClaim?: () => boolean;
  admittedWork?: AdmittedWork;
}

interface HeldRun {
  run: Run;
  claimedAt: number;
  shutdown: AbortController;
  parkRequested: boolean;
}

export interface Worker {
  readonly slots: number;
  start(): void;
  held(): HeldRun[];
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(drainMs?: number): Promise<void>;
  releaseInFlight(fatal?: boolean): Promise<void>;
}

const STOP_DRAIN_MS = 2_000;

export function createWorker(deps: WorkerDeps): Worker {
  const workerId = deps.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  const slots = Math.max(1, deps.slots ?? 1);
  const pollMs = deps.pollMs ?? 50;
  const recoveryPollMs = deps.recoveryPollMs ?? 5_000;
  const notifications = Boolean(deps.runs.subscribeAvailable);
  const admitted = (): boolean => !deps.canClaim || deps.canClaim();
  let generation = 0;
  let wake: (() => void) | null = null;
  let unsubscribe: (() => void) | undefined;
  const notify = (): void => {
    generation++;
    wake?.();
  };
  let full = false;
  async function waitForWork(observed: number): Promise<void> {
    if (stopped || observed !== generation) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = full ? undefined : setTimeout(done, notifications ? recoveryPollMs : pollMs);
      wake = done;
    });
  }
  let stopped = false;
  let loopDone: Promise<void> | null = null;
  let claimDone: Promise<void> | null = null;
  const inFlight = new Set<HeldRun & { done: Promise<void> }>();

  function begin(run: Run): void {
    const shutdown = new AbortController();
    const held = { run, claimedAt: Date.now(), shutdown, parkRequested: false, done: Promise.resolve() };
    inFlight.add(held);
    console.log(`[worker] claimed worker=${workerId} run=${run.id} thread=${run.sessionId}`);
    held.done = (async () => {
      try {
        const work = () =>
          processRun(deps, run, {
            shutdown: shutdown.signal,
            park: { requested: () => held.parkRequested, now: () => shutdown.abort(PARKED) },
          });
        if (deps.admittedWork) await deps.admittedWork.run(work);
        else await work();
      } catch (e) {
        if (!shutdown.signal.aborted) swallow("worker: background run crashed", e);
      } finally {
        if (shutdown.signal.aborted)
          console.log(`[worker] shutdown settled worker=${workerId} run=${run.id} thread=${run.sessionId}`);
        inFlight.delete(held);
        if (full) wake?.();
      }
    })();
  }

  async function claimBatch(limit: number): Promise<number> {
    const batch = await deps.runs.claim(workerId, deps.leaseTtlMs, limit);
    if (batch.length && (stopped || !admitted())) {
      await Promise.all(
        batch.map((run) =>
          withTenant(run.tenantId, () => deps.runs.releaseLease(run.id, run.leaseToken!)).catch((e) =>
            swallow("worker: post-stop claim handback failed", e),
          ),
        ),
      );
      return limit;
    }
    for (const run of batch) begin(run);
    return batch.length;
  }

  async function loop(): Promise<void> {
    let claimFailures = 0;
    while (!stopped) {
      if (!admitted()) {
        await sleep(pollMs);
        continue;
      }
      const free = slots - inFlight.size;
      full = free <= 0;
      if (full) {
        await waitForWork(generation);
        continue;
      }
      const observed = generation;
      const claiming = claimBatch(free);
      claimDone = claiming.then(
        () => {},
        () => {},
      );
      try {
        const claimed = await claiming;
        claimFailures = 0;
        if (claimed < free) await waitForWork(observed);
      } catch (e) {
        claimFailures += 1;
        if (claimFailures === CLAIM_FAIL_REPORT_CONSECUTIVE) reportFailure("worker: persistent claim failure", e);
        swallow("worker: claim failed (transient, retrying)", e);
        await sleep(Math.min(pollMs * 2 ** Math.min(claimFailures, 5), 5_000));
      } finally {
        claimDone = null;
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

  const settled = async (): Promise<void> => {
    await Promise.all([...inFlight.values()].map((held) => held.done));
  };
  const drained = async (): Promise<void> => {
    await loopDone;
    await settled();
  };
  function run(): void {
    loopDone = loop().then(
      () => {
        loopDone = null;
        if (!stopped) run();
      },
      (e: unknown) => {
        loopDone = null;
        reportFailure("worker: claim loop crashed", e);
      },
    );
  }

  return {
    slots,
    held: () => [...inFlight.values()],
    start() {
      stopped = false;
      unsubscribe ??= deps.runs.subscribeAvailable?.(notify, {
        pollMs,
        onResync: notify,
      });
      if (!loopDone) run();
    },
    async releaseInFlight(fatal = false) {
      await stopClaims();
      for (const held of inFlight.values()) held.shutdown.abort(fatal ? CRASHED : undefined);
      await settled();
    },
    stopClaims,
    drained,
    async stop(drainMs = STOP_DRAIN_MS) {
      stopClaims().catch(swallowAs("worker: stop claims", undefined));
      await Promise.race([drained(), sleep(drainMs, { unref: true })]);
    },
  };
}

function runStopFor(err: unknown): RunStop {
  if (err instanceof ProviderTurnError)
    return { kind: "error", code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) };
  return { kind: "error" };
}

export function createRunPreemption(deps: {
  runs: RunStore;
  worker: Worker;
  canClaim?: () => boolean;
  graceMs?: number;
}): { sweep(): Promise<boolean> } {
  let slotPark: HeldRun | undefined;
  let sweeping = false;
  async function sweep(): Promise<boolean> {
    if (deps.canClaim && !deps.canClaim()) return false;
    const createdBefore = Date.now() - (deps.graceMs ?? 1_000);
    const held = deps.worker.held();
    const live = held.filter(
      ({ run, shutdown }) => !shutdown.signal.aborted && run.priority === 2 && run.preemptions < MAX_PREEMPTIONS,
    );
    if (!slotPark || !live.includes(slotPark)) slotPark = undefined;
    if (live.length === 0) return false;
    const blocking = new Set<HeldRun>();
    for (const [tenantId, group] of Map.groupBy(live, ({ run }) => run.tenantId)) {
      const sessionIds = group.map(({ run }) => run.sessionId);
      const waiting = await withTenant(tenantId, () => deps.runs.personWaitingIn(sessionIds, createdBefore));
      for (const held of group) if (waiting.has(held.run.sessionId)) blocking.add(held);
    }
    const waitingElsewhere = held.length >= deps.worker.slots && (await deps.runs.personWaiting(createdBefore));
    if (!waitingElsewhere) slotPark = undefined;
    else if (!slotPark && !held.some(({ shutdown }) => shutdown.signal.aborted))
      slotPark = live.filter((held) => !blocking.has(held)).sort((a, b) => b.claimedAt - a.claimedAt)[0];
    let requested = false;
    for (const run of live) {
      const wanted = blocking.has(run) || run === slotPark;
      requested ||= wanted && !run.parkRequested;
      run.parkRequested = wanted;
    }
    return requested;
  }
  return {
    async sweep() {
      if (sweeping) return false;
      sweeping = true;
      try {
        return await sweep();
      } finally {
        sweeping = false;
      }
    },
  };
}
