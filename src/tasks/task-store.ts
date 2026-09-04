export const TASK_STATUSES = ["pending", "in_progress", "completed", "skipped", "failed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskEventType = "created" | "status_changed";

export interface Task {
  id: string;
  sessionId: string;
  originRunId: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  runId: string;
  type: TaskEventType;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  createdAt: number;
}

export interface CreateTaskInput {
  id?: string;
  sessionId: string;
  originRunId: string;
  title: string;
  status?: TaskStatus;
}

export interface TaskFilter {
  sessionId?: string;
  originRunId?: string;
  statuses?: readonly TaskStatus[];
}

export interface OpenTaskFilter {
  sessionId?: string;
  originRunId?: string;
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<Task>;
  get(id: string): Promise<Task | null>;
  list(filter?: TaskFilter): Promise<Task[]>;
  listOpen(filter?: OpenTaskFilter): Promise<Task[]>;
  transitionStatus(id: string, expectedStatus: TaskStatus, nextStatus: TaskStatus, runId: string): Promise<Task | null>;
  listEvents(taskId: string): Promise<TaskEvent[]>;
  close?(): Promise<void>;
}

const OPEN_STATUSES = new Set<TaskStatus>(["pending", "in_progress"]);

export function isOpenTask(status: TaskStatus): boolean {
  return OPEN_STATUSES.has(status);
}
