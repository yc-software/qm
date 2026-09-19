import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Absurd,
  CancelledTask,
  FailedTask,
  SuspendTask,
  type ClaimedTask,
  type JsonValue,
  type Queryable,
  type TaskContext,
} from "absurd-sdk";
import { createPgPool, type PgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { sleep, withAbort, withTimeout, getOperationSignal, withOperationSignal } from "../util/async.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import type { AdmittedWork } from "../util/admitted-work.ts";
import { jsonbStringify } from "../persistence/durable-map.ts";
import {
  ABSURD_CHECKPOINT_FENCING_MIGRATION,
  ABSURD_HANDOFF_MIGRATION,
  ABSURD_MIGRATION,
  ABSURD_WORKER_FENCING_MIGRATION,
  ABSURD_WORKER_CLAIM_HANDOFF_MIGRATION,
  ABSURD_EXPIRED_HANDOFF_MIGRATION,
  absurdQueueMigration,
  DURABLE_RETRY_STRATEGY,
} from "./schema.ts";
import { createMemoryDurableTasks } from "./memory-tasks.ts";
import { createHandoff, type HandoffSignals } from "../runs/handoff.ts";
import { TurnHandedOff } from "../core/turn-error.ts";

export interface DurableTaskContext {
  readonly taskID: string;
  readonly runID: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly handoff: HandoffSignals;
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
  sleepFor(name: string, seconds: number): Promise<void>;
  sleepUntil(name: string, date: Date): Promise<void>;
  awaitEvent<T>(name: string, options?: { timeoutSeconds?: number; stepName?: string }): Promise<T>;
  heartbeat(seconds?: number): Promise<void>;
}

export const durableTaskContext = new AsyncLocalStorage<DurableTaskContext>();

export interface DurableSpawnOptions {
  idempotencyKey: string;
  at?: number;
  maxAttempts?: number | null;
}

export interface DurableWorkerOptions {
  admittedWork?: AdmittedWork;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseTtlMs?: number;
  workerId?: string;
  canClaim?: () => boolean | Promise<boolean>;
  onError?: (error: unknown) => void;
}

export interface DurableWorker {
  requestHandoff(graceMs: number): void;
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(): Promise<void>;
}

export interface DurableTasks {
  readonly pg?: PgPool;
  ready(): Promise<void>;
  absurd(): Promise<Absurd>;
  register<P, R>(name: string, handler: (ctx: DurableTaskContext, params: P) => Promise<R>): void;
  spawn<P>(name: string, params: P, options: DurableSpawnOptions): Promise<{ taskId: string }>;
  spawnInTransaction<P>(
    client: Queryable,
    name: string,
    params: P,
    options: DurableSpawnOptions,
  ): Promise<{ taskId: string }>;
  result<T>(taskId: string): Promise<T>;
  emitEvent(name: string, payload?: unknown): Promise<void>;
  start(options?: DurableWorkerOptions): DurableWorker;
  close(timeoutMs?: number): Promise<void>;
}

export class DurableTaskDeferred extends Error {
  readonly seconds: number;
  constructor(seconds = 5) {
    super("Workflow is waiting to continue");
    this.seconds = seconds;
  }
}

interface TaskExecution {
  task: ClaimedTask;
  controller: AbortController;
  nativeController: AbortController;
  leaseSeconds: number;
  claimStartedAt: number;
  handoff: HandoffSignals;
  surrender: boolean;
  deferSeconds?: number;
}

export function isDurableControlFlow(error: unknown): boolean {
  const operationSignal = getOperationSignal();
  const taskSignal = durableTaskContext.getStore()?.signal;
  return (
    (operationSignal?.aborted && error === operationSignal.reason) ||
    (taskSignal?.aborted && error === taskSignal.reason) ||
    error instanceof SuspendTask ||
    error instanceof CancelledTask ||
    error instanceof FailedTask ||
    error instanceof TurnHandedOff ||
    error instanceof DurableTaskDeferred
  );
}

export function createDurableTasks(options: { databaseUrl?: string; queue: string }): DurableTasks {
  if (!options.databaseUrl) return createMemoryDurableTasks();
  const queue = options.queue;
  const pg = createPgPool(options.databaseUrl, [
    ABSURD_MIGRATION,
    ABSURD_HANDOFF_MIGRATION,
    ABSURD_CHECKPOINT_FENCING_MIGRATION,
    ABSURD_WORKER_FENCING_MIGRATION,
    ABSURD_WORKER_CLAIM_HANDOFF_MIGRATION,
    ABSURD_EXPIRED_HANDOFF_MIGRATION,
    absurdQueueMigration(queue),
  ]);
  const registrations = new Map<string, (ctx: DurableTaskContext, params: unknown) => Promise<unknown>>();
  const executions = new Map<string, TaskExecution>();
  const executionContext = new AsyncLocalStorage<TaskExecution>();
  const workers = new Set<DurableWorker>();
  let clientPromise: Promise<Absurd> | undefined;
  let closed = false;

  function install(client: Absurd, name: string): void {
    client.registerTask({ name }, async (params: unknown, native: TaskContext) => {
      const execution = executionContext.getStore();
      if (!execution) throw new Error(`Missing execution ownership for ${native.taskID}`);
      const { controller, task, leaseSeconds } = execution;
      const signal = AbortSignal.any([controller.signal, execution.handoff.deadline]);
      const nativeOperations = new Set<Promise<unknown>>();
      const stepScope = new AsyncLocalStorage<boolean>();
      let beat: Promise<void> | undefined;
      let confirmedUntil = execution.claimStartedAt + leaseSeconds * 1000;
      let expires = setTimeout(
        () => controller.abort(new Error("Workflow lease expired")),
        Math.max(0, confirmedUntil - Date.now()),
      );
      expires.unref();
      const check = () => {
        if (Date.now() >= confirmedUntil) controller.abort(new Error("Workflow lease expired"));
        signal.throwIfAborted();
      };
      const boundary = () => {
        check();
        if (!stepScope.getStore() && execution.handoff.requested.aborted) throw new TurnHandedOff();
      };
      const invokeNative = async <T>(run: () => Promise<T>): Promise<T> => {
        check();
        const operation = run();
        nativeOperations.add(operation);
        void operation.finally(() => nativeOperations.delete(operation)).catch(() => {});
        const value = await operation;
        check();
        return value;
      };
      const heartbeat = async (seconds?: number) => {
        check();
        const startedAt = Date.now();
        await invokeNative(() => native.heartbeat(seconds));
        check();
        confirmedUntil = startedAt + (seconds ?? leaseSeconds) * 1000;
        check();
        clearTimeout(expires);
        expires = setTimeout(
          () => controller.abort(new Error("Workflow lease expired")),
          Math.max(0, confirmedUntil - Date.now()),
        );
        expires.unref();
      };
      const timer = setInterval(
        () => {
          if (beat) return;
          beat = heartbeat()
            .catch((error: unknown) => {
              if (isDurableControlFlow(error) || Date.now() >= confirmedUntil) controller.abort(error);
            })
            .finally(() => {
              beat = undefined;
            });
        },
        Math.max(100, Math.floor((leaseSeconds * 1000) / 3)),
      );
      timer.unref();
      const context: DurableTaskContext = {
        taskID: task.task_id,
        runID: task.run_id,
        attempt: task.attempt,
        signal,
        handoff: execution.handoff,
        async step<T>(name: string, run: () => Promise<T>): Promise<T> {
          boundary();
          const saved = await invokeNative(() =>
            native.step<{ value?: T }>(name, async () => {
              await heartbeat();
              boundary();
              const value = await stepScope.run(true, () => withOperationSignal(signal, () => withAbort(run, signal)));
              check();
              return { value };
            }),
          );
          boundary();
          return saved.value as T;
        },
        async sleepFor(name, seconds) {
          boundary();
          await invokeNative(() => native.sleepFor(name, seconds));
          boundary();
        },
        async sleepUntil(name, date) {
          boundary();
          await invokeNative(() => native.sleepUntil(name, date));
          boundary();
        },
        async awaitEvent<T>(name: string, opts?: { timeoutSeconds?: number; stepName?: string }): Promise<T> {
          boundary();
          const result = (await invokeNative(() =>
            native.awaitEvent(name, { timeout: opts?.timeoutSeconds, stepName: opts?.stepName }),
          )) as T;
          boundary();
          return result;
        },
        heartbeat,
      };
      try {
        return await withAbort(async () => {
          const at = native.headers?.qm_schedule_at;
          if (typeof at === "number") await context.sleepUntil("$qm:scheduled", new Date(at));
          boundary();
          const result = await durableTaskContext.run(context, () =>
            withOperationSignal(signal, () => registrations.get(name)!(context, params)),
          );
          check();
          return { value: result };
        }, signal);
      } catch (error) {
        if (controller.signal.aborted) throw new SuspendTask();
        if (error instanceof TurnHandedOff || (execution.handoff.deadline.aborted && error === signal.reason)) {
          execution.surrender = true;
          throw new SuspendTask();
        }
        if (error instanceof DurableTaskDeferred) {
          execution.deferSeconds = error.seconds;
          throw new SuspendTask();
        }
        if (!isDurableControlFlow(error))
          reportFailure("workflow: task", error, `queue=${queue} task=${task.task_name}`);
        throw error;
      } finally {
        clearInterval(timer);
        clearTimeout(expires);
        await withAbort(() => Promise.allSettled(nativeOperations), signal).catch(() => undefined);
        controller.abort(new SuspendTask());
        clearTimeout(expires);
      }
    });
  }

  function absurd(): Promise<Absurd> {
    if (closed) return Promise.reject(new Error("Workflow runtime is closed"));
    clientPromise ??= pg
      .pool()
      .then((pool) => {
        const db: Queryable = {
          query: (async (text: string, values?: unknown[]) => {
            text = text.replace("FROM absurd.claim_task(", "FROM qm_claim_tasks(");
            const execution = executionContext.getStore();
            const signal = execution
              ? AbortSignal.any([execution.nativeController.signal, execution.handoff.deadline])
              : getOperationSignal();
            if (!signal) return pool.query(text, values);
            try {
              signal.throwIfAborted();
              const result = await withAbort(() => pg.query(text, values, { signal }), signal);
              signal.throwIfAborted();
              return result;
            } catch (error) {
              if (!signal.aborted || !execution) throw error;
              if (execution.handoff.deadline.aborted) execution.surrender = true;
              throw new SuspendTask();
            }
          }) as Queryable["query"],
        };
        const client = new Absurd({ db: pool, queueName: queue, defaultMaxAttempts: 100 }).bindToConnection(db);
        for (const name of registrations.keys()) install(client, name);
        return client;
      })
      .catch((error: unknown) => {
        clientPromise = undefined;
        throw error;
      });
    return clientPromise;
  }

  const spawnInTransaction: DurableTasks["spawnInTransaction"] = async (connection, name, params, opts) => {
    if (!opts.idempotencyKey) throw new Error("Durable tasks require an idempotency key");
    await absurd();
    const result = await connection.query<{ task_id: string }>(
      "SELECT task_id FROM absurd.spawn_task($1, $2, $3, $4)",
      [
        queue,
        name,
        jsonbStringify(params),
        JSON.stringify({
          idempotency_key: opts.idempotencyKey,
          max_attempts: opts.maxAttempts === undefined ? 100 : opts.maxAttempts,
          retry_strategy: DURABLE_RETRY_STRATEGY,
          ...(opts.at === undefined ? {} : { headers: { qm_schedule_at: opts.at } }),
        }),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Workflow admission returned no task");
    return { taskId: row.task_id };
  };

  function start(opts: DurableWorkerOptions = {}): DurableWorker {
    const concurrency = opts.concurrency ?? 8;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Workflow concurrency must be positive");
    const leaseSeconds = Math.max(1, Math.ceil((opts.leaseTtlMs ?? 120_000) / 1000));
    const workerId = `${opts.workerId ?? queue}:${randomUUID()}`;
    const handoff = createHandoff();
    const onError = opts.onError ?? ((error: unknown) => reportFailure("workflow: worker", error, `queue=${queue}`));
    const activeRuns = new Set<string>();
    let fenced: Promise<void> | undefined;
    const fence = () =>
      (fenced ??= pg
        .q("SELECT qm_handoff_worker($1, $2, $3::uuid[])", [queue, workerId, [...activeRuns]])
        .then(() => undefined));
    let surrendered: Promise<void> | undefined;
    const surrender = () =>
      (surrendered ??= pg.q("SELECT qm_handoff_worker($1, $2)", [queue, workerId]).then(() => undefined));
    const onDeadline = () => void surrender().catch(onError);
    handoff.signals().deadline.addEventListener("abort", onDeadline, { once: true });
    const executing = new Set<Promise<void>>();
    let stopping = false;
    let wake: (() => void) | undefined;
    const idle = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, opts.pollIntervalMs ?? 250);
        timer.unref();
        function done() {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = done;
      });
    const claims = (async () => {
      while (!stopping) {
        try {
          if (executing.size >= concurrency || (opts.canClaim && !(await opts.canClaim()))) {
            await idle();
            continue;
          }
          const client = await absurd();
          const claimStartedAt = Date.now();
          const tasks = await withOperationSignal(handoff.signals().deadline, () =>
            client.claimTasks({
              workerId,
              claimTimeout: leaseSeconds,
              batchSize: concurrency - executing.size,
            }),
          );
          if (stopping || (opts.canClaim && !(await opts.canClaim()))) {
            for (const task of tasks) await pg.q("SELECT qm_handoff_run($1, $2, $3)", [queue, task.run_id, workerId]);
            continue;
          }
          for (const task of tasks) {
            const controller = new AbortController();
            const owned: TaskExecution = {
              task,
              controller,
              nativeController: new AbortController(),
              leaseSeconds,
              claimStartedAt,
              handoff: handoff.signals(),
              surrender: false,
            };
            executions.set(task.run_id, owned);
            activeRuns.add(task.run_id);
            const run = async () => {
              try {
                await executionContext.run(owned, () =>
                  client.executeTask(task, leaseSeconds, { fatalOnLeaseTimeout: false }),
                );
              } catch (error) {
                if (!owned.surrender) throw error;
              } finally {
                owned.nativeController.abort(new SuspendTask());
              }
              if (owned.surrender) await pg.q("SELECT qm_handoff_run($1, $2, $3)", [queue, task.run_id, workerId]);
              else if (owned.deferSeconds !== undefined)
                await pg.q(
                  "SELECT absurd.schedule_run($1, $2, absurd.current_time() + make_interval(secs => $3::double precision))",
                  [queue, task.run_id, owned.deferSeconds],
                );
            };
            const execution = (opts.admittedWork ? opts.admittedWork.run(run) : run()).catch(onError).finally(() => {
              executions.delete(task.run_id);
              activeRuns.delete(task.run_id);
              executing.delete(execution);
              wake?.();
            });
            executing.add(execution);
          }
          if (!tasks.length) await idle();
        } catch (error) {
          if (!handoff.signals().deadline.aborted) onError(error);
          if (!stopping) await idle();
        }
      }
    })().catch(onError);
    const worker: DurableWorker = {
      requestHandoff(graceMs) {
        stopping = true;
        void fence().catch(onError);
        handoff.request(graceMs);
        wake?.();
      },
      async stopClaims() {
        stopping = true;
        wake?.();
        await claims;
      },
      async drained() {
        await claims;
        await Promise.allSettled(executing);
        if (handoff.signals().requested.aborted) await surrender();
        handoff.signals().deadline.removeEventListener("abort", onDeadline);
      },
      async stop() {
        await worker.stopClaims();
        await worker.drained();
        workers.delete(worker);
      },
    };
    workers.add(worker);
    return worker;
  }

  return {
    pg,
    absurd,
    ready: async () => {
      await absurd();
    },
    register<P, R>(name: string, handler: (ctx: DurableTaskContext, params: P) => Promise<R>) {
      if (registrations.has(name)) throw new Error(`Workflow already registered: ${name}`);
      registrations.set(name, (ctx, params) => handler(ctx, params as P));
      if (clientPromise) void clientPromise.then((client) => install(client, name));
    },
    spawnInTransaction,
    async spawn(name, params, opts) {
      const pool = await pg.pool();
      return withPgTransaction(pool, (connection) => spawnInTransaction(connection, name, params, opts));
    },
    async result<T>(taskId: string): Promise<T> {
      const client = await absurd();
      const current = durableTaskContext.getStore();
      while (!closed) {
        const state = await client.fetchTaskResult(taskId);
        if (!state) throw new Error(`Workflow not found: ${taskId}`);
        if (state.state === "completed") return (state.result as { value: T }).value;
        if (state.state === "failed" || state.state === "cancelled")
          throw new Error(`Workflow ${taskId} ${state.state}: ${JSON.stringify(state)}`);
        if (current?.handoff.requested.aborted) throw new TurnHandedOff();
        current?.signal.throwIfAborted();
        await sleep(100);
      }
      throw new Error("Workflow runtime closed while waiting for a result");
    },
    async emitEvent(name, payload) {
      await (await absurd()).emitEvent(name, (payload ?? null) as JsonValue);
    },
    start,
    async close(timeoutMs = 2000) {
      closed = true;
      const stopping = Promise.all([...workers].map((worker) => worker.stop()));
      for (const { controller, nativeController } of executions.values()) {
        controller.abort(new SuspendTask());
        nativeController.abort(new SuspendTask());
      }
      await withTimeout(
        async () => {
          await stopping;
          if (clientPromise) await (await clientPromise).close();
          await pg.close();
        },
        timeoutMs,
        `workflow ${queue} close`,
      ).catch((error: unknown) => console.error(errMessage(error)));
    },
  };
}
