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
  setEnabled(id: string, enabled: boolean): Promise<void>;
  delete(id: string): Promise<void>;
  advance(id: string, fields: { cursor: number; tail?: string; firedAt?: number }): Promise<void>;
  update(id: string, fields: { instructions?: string; pattern?: string; cursor?: number }): Promise<void>;
  recordError(id: string, error: string): Promise<void>;
}

export function createMonitorStore(backing: DurableMap<Monitor> = createMemoryMap<Monitor>()): MonitorStore {
  return {
    async create(input) {
      assertNoEscalation(input);
      const monitor: Monitor = {
        ...buildTriggerBase(input, randomUUID(), Date.now()),
        processId: input.processId,
        command: input.command,
        threadRef: input.threadRef,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        cursor: input.cursor ?? 0,
        expiresAt: input.expiresAt,
      };
      await backing.put(monitor.id, monitor);
      return monitor;
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    async enabled() {
      return (await backing.all()).filter((m) => m.enabled);
    },
    setEnabled(id, enabled) {
      return setTriggerEnabled(backing, id, enabled);
    },
    delete: (id) => backing.delete(id),
    async advance(id, fields) {
      await backing.merge(id, {
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
      if (Object.keys(patch).length) await backing.merge(id, patch);
    },
    async recordError(id, error) {
      await backing.merge(id, { lastError: error });
    },
  };
}
