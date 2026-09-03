import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";

export const UPDATE_JOB_STATES = ["dispatching", "queued", "running", "succeeded", "failed"] as const;

export type UpdateJobState = (typeof UPDATE_JOB_STATES)[number];

export interface UpdateJob {
  id: string;
  scopeId: ScopeId;
  requestedBy: string;
  currentVersion: string;
  targetVersion: string;
  state: UpdateJobState;
  detail?: string;
  runUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateJobStore {
  create(input: {
    scopeId: ScopeId;
    requestedBy: string;
    currentVersion: string;
    targetVersion: string;
  }): Promise<{ job: UpdateJob; created: boolean }>;
  get(scopeId: ScopeId, id: string): Promise<UpdateJob | null>;
  latest(scopeId: ScopeId): Promise<UpdateJob | null>;
  update(
    scopeId: ScopeId,
    id: string,
    expectedState: UpdateJobState,
    patch: { state: UpdateJobState; detail?: string; runUrl?: string },
  ): Promise<UpdateJob | null>;
  close?(): Promise<void>;
}

const open = (job: UpdateJob): boolean =>
  job.state === "dispatching" || job.state === "queued" || job.state === "running";

export function createMemoryUpdateJobStore(now: () => number = Date.now): UpdateJobStore {
  const jobs = new Map<string, UpdateJob>();
  return {
    async create(input) {
      const existing = [...jobs.values()]
        .filter((job) => job.scopeId === input.scopeId && open(job))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (existing) return { job: { ...existing }, created: false };
      const at = now();
      const job: UpdateJob = {
        id: randomUUID(),
        ...input,
        state: "dispatching",
        createdAt: at,
        updatedAt: at,
      };
      jobs.set(job.id, job);
      return { job: { ...job }, created: true };
    },
    async get(scopeId, id) {
      const job = jobs.get(id);
      return job?.scopeId === scopeId ? { ...job } : null;
    },
    async latest(scopeId) {
      const job = [...jobs.values()]
        .filter((candidate) => candidate.scopeId === scopeId)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return job ? { ...job } : null;
    },
    async update(scopeId, id, expectedState, patch) {
      const job = jobs.get(id);
      if (!job || job.scopeId !== scopeId || job.state !== expectedState) return null;
      const updated = { ...job, ...patch, updatedAt: now() };
      jobs.set(id, updated);
      return { ...updated };
    },
  };
}
