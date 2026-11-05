import { randomUUID } from "node:crypto";
import type { Monitor } from "../triggers/types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  setTriggerEnabled,
  type CreateTriggerInput,
  ownedBy,
} from "../triggers/trigger-store.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { currentTenant } from "../tenants/context.ts";

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
  list(): Promise<Monitor[]>;
  ownedBy(scopeId: string): Promise<Monitor[]>;
  enabled(): Promise<Monitor[]>;
  claimEnabled(): Promise<Array<Monitor & { tenantId: string }>>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  delete(id: string): Promise<void>;
  deleteDefunct(now: number): Promise<number>;
  advance(id: string, fields: { cursor: number; tail?: string; firedAt?: number }): Promise<void>;
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

export function createMonitorStore(backing: DurableMap<Monitor>): MonitorStore {
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
      await backing.put(monitor.id, monitor);
      return monitor;
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    ownedBy: (scopeId) => ownedBy(backing, scopeId),
    async enabled() {
      return (await backing.all()).filter((m) => m.enabled);
    },
    async claimEnabled() {
      const claimed = await claimThenBind(backing.claimTenants, async () =>
        (await backing.all()).filter((m) => m.enabled).map((m) => ({ ...m, tenantId: currentTenant() })),
      );
      return claimed.flat();
    },
    setEnabled(id, enabled) {
      return setTriggerEnabled(backing, id, enabled);
    },
    delete: (id) => backing.delete(id),
    async deleteDefunct(now) {
      const isDefunct = defunctBefore(now - DEFUNCT_MONITOR_GRACE_MS);
      const deleted = await claimThenBind(backing.claimTenants, async () => {
        const defunct = (await backing.entries()).filter(([, m]) => isDefunct(m));
        return Promise.all(defunct.map(([id]) => backing.deleteIf(id, isDefunct)));
      });
      return deleted.flat().filter(Boolean).length;
    },
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
