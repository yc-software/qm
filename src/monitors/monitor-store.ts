import type { DurableTasks } from "../durable/tasks.ts";
import { randomUUID } from "node:crypto";
import type { Monitor } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  setTriggerEnabled,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";

interface CreateMonitorInput extends CreateTriggerInput {
  processId: string;
  command: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor?: number;
  expiresAt: number;
}

export interface MonitorStore {
  create(input: CreateMonitorInput): Promise<Monitor>;
  get(id: string): Promise<Monitor | null>;
  list(): Promise<Monitor[]>;
  enabled(): Promise<Monitor[]>;
  setEnabled(id: string, enabled: boolean, revision?: string): Promise<void>;
  delete(id: string): Promise<void>;
  deleteDefunct(now: number): Promise<number>;
  advance(id: string, fields: { cursor: number; tail?: string; firedAt?: number }, revision?: string): Promise<void>;
  update(id: string, fields: { instructions?: string; pattern?: string; cursor?: number }): Promise<void>;
  recordError(id: string, error: string): Promise<void>;
}

const DEFUNCT_MONITOR_GRACE_MS = 7 * 24 * 60 * 60_000;

function lastActivityAt(m: Monitor): number {
  return Math.max(m.expiresAt ?? 0, m.lastFiredAt ?? 0, m.createdAt);
}

function defunctBefore(cutoff: number): (m: Monitor) => boolean {
  return (m) => !m.enabled && lastActivityAt(m) <= cutoff;
}

export function createMonitorStore(
  backing: DurableMap<Monitor> = createMemoryMap<Monitor>(),
  tasks?: DurableTasks,
): MonitorStore {
  async function schedule(monitor: Monitor | null): Promise<void> {
    if (!tasks || !monitor?.enabled) return;
    await tasks.spawn(
      "monitor.watch",
      { monitorId: monitor.id, revision: monitor.workflowRevision, sequence: 0 },
      {
        idempotencyKey: `monitor:${monitor.id}:${monitor.workflowRevision ?? "legacy"}:0`,
      },
    );
  }
  return {
    async create(input) {
      assertNoEscalation(input);
      const monitor: Monitor = {
        ...buildTriggerBase(input, randomUUID(), Date.now()),
        workflowRevision: randomUUID(),
        processId: input.processId,
        command: input.command,
        threadRef: input.threadRef,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        cursor: input.cursor ?? 0,
        expiresAt: input.expiresAt,
      };
      await backing.put(monitor.id, monitor);
      await schedule(monitor);
      return monitor;
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    async enabled() {
      return (await backing.all()).filter((m) => m.enabled);
    },
    async setEnabled(id, enabled, revision) {
      if (revision !== undefined && backing.update) {
        await backing.update(id, (monitor) =>
          (monitor.workflowRevision ?? "legacy") === revision ? { ...monitor, enabled } : monitor,
        );
        return;
      }
      await setTriggerEnabled(backing, id, enabled);
      if (enabled) {
        await backing.merge(id, { workflowRevision: randomUUID() });
        await schedule(await backing.get(id));
      }
    },
    delete: (id) => backing.delete(id),
    async deleteDefunct(now) {
      const isDefunct = defunctBefore(now - DEFUNCT_MONITOR_GRACE_MS);
      let deleted = 0;
      for (const m of (await backing.all()).filter(isDefunct)) {
        if (backing.deleteIf) {
          if (await backing.deleteIf(m.id, isDefunct)) deleted++;
        } else {
          await backing.delete(m.id);
          deleted++;
        }
      }
      return deleted;
    },
    async advance(id, fields, revision) {
      const patch = {
        cursor: fields.cursor,
        tail: fields.tail,
        ...(fields.firedAt !== undefined ? { lastFiredAt: fields.firedAt } : {}),
      };
      if (revision !== undefined && backing.update) {
        await backing.update(id, (monitor) =>
          monitor.enabled && (monitor.workflowRevision ?? "legacy") === revision ? { ...monitor, ...patch } : monitor,
        );
      } else await backing.merge(id, patch);
    },
    async update(id, fields) {
      const patch: Partial<Monitor> = {
        ...(fields.instructions !== undefined ? { instructions: fields.instructions } : {}),
        ...(fields.pattern !== undefined ? { pattern: fields.pattern } : {}),
        ...(fields.cursor !== undefined ? { cursor: fields.cursor, tail: undefined } : {}),
      };
      if (Object.keys(patch).length) {
        await backing.merge(id, { ...patch, workflowRevision: randomUUID() });
        await schedule(await backing.get(id));
      }
    },
    async recordError(id, error) {
      await backing.merge(id, { lastError: error });
    },
  };
}
