import { randomUUID } from "node:crypto";
import type { Monitor } from "../triggers/types.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  type CreateTriggerInput,
  withFields,
} from "../triggers/trigger-store.ts";
import { type MonitorRows, type TenantMonitor } from "./monitor-table.ts";

interface CreateMonitorInput extends CreateTriggerInput {
  processId: string;
  command: string;
  purpose?: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor?: number;
  expiresAt: number;
}

export interface MonitorStore {
  create(input: CreateMonitorInput): Promise<Monitor>;
  get(id: string): Promise<Monitor | null>;
  ownedBy(scopeId: string): Promise<Monitor[]>;
  watching(threadRefs: readonly string[]): Promise<Monitor[]>;
  enabled(): Promise<TenantMonitor[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  delete(id: string): Promise<void>;
  deleteDefunct(now: number): Promise<number>;
  advance(id: string, fields: { cursor: number; tail?: string; firedAt?: number }): Promise<void>;
  update(id: string, fields: { instructions?: string; pattern?: string; cursor?: number }): Promise<void>;
  recordError(id: string, error: string): Promise<void>;
}

const DEFUNCT_MONITOR_GRACE_MS = 7 * 24 * 60 * 60_000;

export function createMonitorStore(rows: MonitorRows): MonitorStore {
  const edit = async (id: string, fields: Partial<Monitor>) => {
    await rows.update(id, (monitor) => withFields(monitor, fields));
  };
  return {
    async create(input) {
      assertNoEscalation(input);
      const monitor: Monitor = {
        ...buildTriggerBase(input, randomUUID(), Date.now()),
        processId: input.processId,
        command: input.command,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        threadRef: input.threadRef,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        cursor: input.cursor ?? 0,
        expiresAt: input.expiresAt,
      };
      await rows.insert(monitor);
      return monitor;
    },
    get: (id) => rows.get(id),
    ownedBy: (scopeId) => rows.ownedBy(scopeId),
    watching: (threadRefs) => rows.watching(threadRefs),
    enabled: () => rows.enabled(),
    setEnabled: (id, enabled) => edit(id, { enabled }),
    delete: (id) => rows.delete(id),
    deleteDefunct: (now) => rows.deleteDisabledBefore(now - DEFUNCT_MONITOR_GRACE_MS),
    async advance(id, fields) {
      await edit(id, {
        cursor: fields.cursor,
        tail: fields.tail,
        ...(fields.firedAt !== undefined ? { lastFiredAt: fields.firedAt } : {}),
      });
    },
    async update(id, fields) {
      const patch: Partial<Monitor> = {
        ...(fields.instructions !== undefined ? { instructions: fields.instructions } : {}),
        ...(fields.pattern !== undefined ? { pattern: fields.pattern } : {}),
        ...(fields.cursor !== undefined ? { cursor: fields.cursor, tail: undefined } : {}),
      };
      if (Object.keys(patch).length) await edit(id, patch);
    },
    recordError: (id, error) => edit(id, { lastError: error }),
  };
}
