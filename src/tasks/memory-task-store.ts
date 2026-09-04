import { randomUUID } from "node:crypto";
import type {
  CreateTaskInput,
  OpenTaskFilter,
  Task,
  TaskEvent,
  TaskFilter,
  TaskStatus,
  TaskStore,
} from "./task-store.ts";
import { isOpenTask } from "./task-store.ts";

export function createMemoryTaskStore(opts: { now?: () => number } = {}): TaskStore {
  const now = opts.now ?? (() => Date.now());
  const tasks = new Map<string, Task>();
  const events = new Map<string, TaskEvent[]>();
  let nextEventId = 1;

  function copyTask(task: Task): Task {
    return { ...task };
  }

  function appendEvent(
    taskId: string,
    runId: string,
    fromStatus: TaskStatus | null,
    toStatus: TaskStatus,
    at: number,
  ): void {
    const taskEvents = events.get(taskId) ?? [];
    taskEvents.push({
      id: String(nextEventId++),
      taskId,
      runId,
      type: fromStatus === null ? "created" : "status_changed",
      fromStatus,
      toStatus,
      createdAt: at,
    });
    events.set(taskId, taskEvents);
  }

  function matches(task: Task, filter: TaskFilter | OpenTaskFilter): boolean {
    return (
      (filter.sessionId === undefined || task.sessionId === filter.sessionId) &&
      (filter.originRunId === undefined || task.originRunId === filter.originRunId)
    );
  }

  function ordered(values: Iterable<Task>): Task[] {
    return [...values].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(copyTask);
  }

  return {
    async create(input: CreateTaskInput): Promise<Task> {
      const id = input.id ?? randomUUID();
      if (tasks.has(id)) throw new Error(`task ${id} already exists`);
      const at = now();
      const task: Task = {
        id,
        sessionId: input.sessionId,
        originRunId: input.originRunId,
        title: input.title,
        status: input.status ?? "pending",
        createdAt: at,
        updatedAt: at,
      };
      tasks.set(id, task);
      appendEvent(id, input.originRunId, null, task.status, at);
      return copyTask(task);
    },

    async get(id): Promise<Task | null> {
      const task = tasks.get(id);
      return task ? copyTask(task) : null;
    },

    async list(filter: TaskFilter = {}): Promise<Task[]> {
      const statuses = filter.statuses ? new Set(filter.statuses) : null;
      return ordered(
        [...tasks.values()].filter((task) => matches(task, filter) && (!statuses || statuses.has(task.status))),
      );
    },

    async listOpen(filter: OpenTaskFilter = {}): Promise<Task[]> {
      return ordered([...tasks.values()].filter((task) => matches(task, filter) && isOpenTask(task.status)));
    },

    async transitionStatus(id, expectedStatus, nextStatus, runId): Promise<Task | null> {
      const task = tasks.get(id);
      if (!task || task.status !== expectedStatus) return null;
      const at = now();
      task.status = nextStatus;
      task.updatedAt = at;
      appendEvent(id, runId, expectedStatus, nextStatus, at);
      return copyTask(task);
    },

    async listEvents(taskId): Promise<TaskEvent[]> {
      return (events.get(taskId) ?? []).map((event) => ({ ...event }));
    },
  };
}
