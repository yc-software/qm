import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import type { GrokJob, JobStore } from "./types.ts";

export type { JobStore } from "./types.ts";

export function createJobStore(backing: DurableMap<GrokJob> = createMemoryMap<GrokJob>()): JobStore {
  return {
    async create(job) {
      await backing.put(job.id, job);
      return job;
    },
    get: (id) => backing.get(id),
    async save(job) {
      await backing.put(job.id, job);
      return job;
    },
    async listByPairing(pairingId) {
      return (await backing.all()).filter((job) => job.pairingId === pairingId);
    },
  };
}
