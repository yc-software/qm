import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { SuspendTask, TimeoutError } from "absurd-sdk";
import { reportFailure } from "../util/errors.ts";
import { sleep, withAbort, withOperationSignal } from "../util/async.ts";
import type { DurableTasks, DurableTaskContext, DurableWorker, DurableWorkerOptions } from "./tasks.ts";
import { DurableTaskDeferred, durableTaskContext } from "./tasks.ts";
import { createHandoff, type HandoffSignals } from "../runs/handoff.ts";
import { TurnHandedOff } from "../core/turn-error.ts";

interface MemoryTask {
  id: string;
  runId: string;
  name: string;
  params: unknown;
  state: "pending" | "running" | "done" | "failed";
  attempt: number;
  maxAttempts: number;
  availableAt: number;
  result?: unknown;
  error?: unknown;
  checkpoints: Map<string, unknown>;
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function createMemoryDurableTasks(): DurableTasks {
  const handlers = new Map<string, (ctx: DurableTaskContext, params: unknown) => Promise<unknown>>();
  const tasks = new Map<string, MemoryTask>();
  const keys = new Map<string, string>();
  const events = new Map<string, unknown>();
  const workers = new Set<DurableWorker>();
  const executions = new Map<MemoryTask, AbortController>();
  let closed = false;

  function context(task: MemoryTask, controller: AbortController, handoff: HandoffSignals): DurableTaskContext {
    const signal = AbortSignal.any([controller.signal, handoff.deadline]);
    const stepScope = new AsyncLocalStorage<boolean>();
    const check = () => signal.throwIfAborted();
    const boundary = () => {
      check();
      if (!stepScope.getStore() && handoff.requested.aborted) throw new TurnHandedOff();
    };
    const occurrences = new Map<string, number>();
    const nameFor = (name: string) => {
      const count = (occurrences.get(name) ?? 0) + 1;
      occurrences.set(name, count);
      return count === 1 ? name : `${name}#${count}`;
    };
    const ctx: DurableTaskContext = {
      taskID: task.id,
      runID: task.runId,
      attempt: task.attempt,
      signal,
      handoff,
      async step<T>(name: string, run: () => Promise<T>): Promise<T> {
        boundary();
        const key = nameFor(name);
        if (task.checkpoints.has(key)) return copy(task.checkpoints.get(key)) as T;
        const value = await stepScope.run(true, () => withOperationSignal(signal, () => withAbort(run, signal)));
        check();
        task.checkpoints.set(key, copy(value));
        boundary();
        return value;
      },
      async sleepFor(name, seconds) {
        await ctx.sleepUntil(name, new Date(Date.now() + seconds * 1000));
      },
      async sleepUntil(name, date) {
        boundary();
        const key = nameFor(name);
        const at = task.checkpoints.has(key) ? (task.checkpoints.get(key) as number) : date.getTime();
        task.checkpoints.set(key, at);
        if (at > Date.now()) {
          task.availableAt = at;
          throw new SuspendTask();
        }
      },
      async awaitEvent<T>(name: string, options?: { timeoutSeconds?: number; stepName?: string }): Promise<T> {
        boundary();
        const key = nameFor(options?.stepName ?? `$awaitEvent:${name}`);
        if (task.checkpoints.has(key)) return copy(task.checkpoints.get(key)) as T;
        if (events.has(name)) {
          const value = copy(events.get(name));
          task.checkpoints.set(key, value);
          return value as T;
        }
        const timeoutKey = `${key}:deadline`;
        let deadline = task.checkpoints.get(timeoutKey) as number | undefined;
        if (deadline === undefined && options?.timeoutSeconds !== undefined) {
          deadline = Date.now() + options.timeoutSeconds * 1000;
          task.checkpoints.set(timeoutKey, deadline);
        }
        if (deadline !== undefined && Date.now() >= deadline) throw new TimeoutError(`Timed out waiting for ${name}`);
        task.availableAt = Math.min(Date.now() + 25, deadline ?? Infinity);
        throw new SuspendTask();
      },
      async heartbeat() {
        check();
      },
    };
    return ctx;
  }

  async function execute(task: MemoryTask, handoff: HandoffSignals): Promise<void> {
    const handler = handlers.get(task.name);
    if (!handler) {
      task.availableAt = Date.now() + 100;
      task.state = "pending";
      return;
    }
    task.state = "running";
    const controller = new AbortController();
    const ctx = context(task, controller, handoff);
    executions.set(task, controller);
    try {
      task.result = copy(
        await durableTaskContext.run(ctx, () =>
          withOperationSignal(ctx.signal, () => withAbort(() => handler(ctx, copy(task.params)), ctx.signal)),
        ),
      );
      task.state = "done";
    } catch (error) {
      if (error instanceof TurnHandedOff || (handoff.deadline.aborted && error === ctx.signal.reason)) {
        task.state = "pending";
        task.availableAt = Date.now();
        task.runId = randomUUID();
        return;
      }
      if (error instanceof DurableTaskDeferred) {
        task.availableAt = Date.now() + error.seconds * 1000;
        task.state = "pending";
        return;
      }
      if (error instanceof SuspendTask) {
        task.state = "pending";
        return;
      }
      reportFailure("workflow: task", error, `task=${task.name}`);
      task.error = error;
      if (task.attempt >= task.maxAttempts) {
        task.state = "failed";
        return;
      }
      task.state = "pending";
      task.availableAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(task.attempt - 1, 9));
      task.attempt++;
      task.runId = randomUUID();
    } finally {
      controller.abort(new SuspendTask());
      executions.delete(task);
    }
  }

  function start(options: DurableWorkerOptions = {}): DurableWorker {
    const concurrency = options.concurrency ?? 8;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Workflow concurrency must be positive");
    let stopped = false;
    const handoff = createHandoff();
    let wake: (() => void) | undefined;
    const executing = new Set<Promise<void>>();
    const claims = (async () => {
      while (!stopped) {
        if (!options.canClaim || (await options.canClaim())) {
          for (const task of tasks.values()) {
            if (stopped || executing.size >= concurrency) break;
            if (task.state !== "pending" || task.availableAt > Date.now()) continue;
            task.state = "running";
            const run = () => execute(task, handoff.signals());
            const execution = (options.admittedWork ? options.admittedWork.run(run) : run())
              .catch((error: unknown) => {
                task.state = "pending";
                options.onError?.(error);
              })
              .finally(() => executing.delete(execution));
            executing.add(execution);
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, options.pollIntervalMs ?? 10);
          timer.unref();
          function done() {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          }
          wake = done;
        });
      }
    })();
    const worker: DurableWorker = {
      requestHandoff(graceMs) {
        stopped = true;
        handoff.request(graceMs);
        wake?.();
      },
      async stopClaims() {
        stopped = true;
        wake?.();
        await claims;
      },
      async drained() {
        await claims;
        await Promise.allSettled(executing);
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
    async ready() {},
    async absurd() {
      throw new Error("The in-memory workflow adapter has no PostgreSQL client");
    },
    register<P, R>(name: string, handler: (ctx: DurableTaskContext, params: P) => Promise<R>) {
      if (handlers.has(name)) throw new Error(`Workflow already registered: ${name}`);
      handlers.set(name, (ctx, params) => handler(ctx, params as P));
    },
    async spawn(name, params, options) {
      if (closed) throw new Error("Workflow runtime is closed");
      if (!options.idempotencyKey) throw new Error("Durable tasks require an idempotency key");
      const known = keys.get(options.idempotencyKey);
      if (known) return { taskId: known };
      const id = randomUUID();
      tasks.set(id, {
        id,
        runId: randomUUID(),
        name,
        params: copy(params),
        state: "pending",
        attempt: 1,
        maxAttempts: options.maxAttempts === null ? Infinity : (options.maxAttempts ?? 100),
        availableAt: options.at ?? Date.now(),
        checkpoints: new Map(),
      });
      keys.set(options.idempotencyKey, id);
      return { taskId: id };
    },
    async spawnInTransaction() {
      throw new Error("An in-memory task cannot participate in a PostgreSQL transaction");
    },
    async result<T>(taskId: string): Promise<T> {
      const current = durableTaskContext.getStore();
      while (!closed) {
        const task = tasks.get(taskId);
        if (!task) throw new Error(`Workflow not found: ${taskId}`);
        if (task.state === "done") return copy(task.result) as T;
        if (task.state === "failed") throw task.error;
        if (current?.handoff.requested.aborted) throw new TurnHandedOff();
        current?.signal.throwIfAborted();
        await sleep(10);
      }
      throw new Error("Workflow runtime closed while waiting for a result");
    },
    async emitEvent(name, payload) {
      if (!events.has(name)) events.set(name, copy(payload ?? null));
    },
    start,
    async close() {
      closed = true;
      for (const controller of executions.values()) controller.abort(new SuspendTask());
      await Promise.all([...workers].map((worker) => worker.stop()));
    },
  };
}
