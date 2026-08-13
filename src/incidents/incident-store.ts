import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";

export type OperatorIncidentSource = "run" | "backend";
export type OperatorIncidentSeverity = "warning" | "error" | "critical";
export type OperatorIncidentStatus = "open" | "recovered" | "acknowledged" | "resolved";

export interface OperatorIncident {
  id: string;
  idempotencyKey: string;
  source: OperatorIncidentSource;
  severity: OperatorIncidentSeverity;
  status: OperatorIncidentStatus;
  category: string;
  code: string;
  intentional: boolean;
  discrepancy: boolean;
  occurredAt: number;
  createdAt: number;
  updatedAt: number;
  scopeLabel: ScopeId;
  sessionId?: string;
  runId?: string;
  actorLabel?: string;
  surface?: string;
  requestSummary?: string;
  backendMessage: string;
  replySummary?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  attempts?: number;
  toolFailureCount?: number;
  backendErrorCount?: number;
  notificationRequested: boolean;
  notificationDeliveryId?: string;
  notificationQueuedAt?: number;
  notificationDeliveredAt?: number;
}

export interface RecordOperatorIncident extends Omit<
  OperatorIncident,
  "id" | "createdAt" | "updatedAt" | "notificationDeliveryId" | "notificationQueuedAt" | "notificationDeliveredAt"
> {
  id?: string;
}

export interface IncidentCursor {
  occurredAt: number;
  id: string;
}

export interface IncidentListOptions {
  scopeId?: string;
  sessionId?: string;
  status?: OperatorIncidentStatus;
  severity?: OperatorIncidentSeverity;
  source?: OperatorIncidentSource;
  limit?: number;
  before?: IncidentCursor;
}

export interface OperatorIncidentStore {
  record(input: RecordOperatorIncident): Promise<OperatorIncident>;
  get(id: string): Promise<OperatorIncident | null>;
  list(opts?: IncidentListOptions): Promise<OperatorIncident[]>;
  count(opts?: Omit<IncidentListOptions, "limit" | "before">): Promise<number>;
  pendingNotifications(limit?: number): Promise<OperatorIncident[]>;
  pendingReceipts(limit?: number): Promise<OperatorIncident[]>;
  pendingEscalations(before: number, limit?: number): Promise<OperatorIncident[]>;
  requestNotification(id: string, at: number): Promise<OperatorIncident | null>;
  markStatus(id: string, status: OperatorIncidentStatus, at: number): Promise<OperatorIncident | null>;
  markNotificationQueued(id: string, deliveryId: string, at: number): Promise<OperatorIncident | null>;
  markNotificationDelivered(id: string, at: number): Promise<OperatorIncident | null>;
  close?(): Promise<void>;
}

function beforeCursor(incident: OperatorIncident, cursor: IncidentCursor | undefined): boolean {
  if (!cursor) return true;
  if (incident.occurredAt !== cursor.occurredAt) return incident.occurredAt < cursor.occurredAt;
  return incident.id < cursor.id;
}

export function createOperatorIncidentStore(now: () => number = Date.now): OperatorIncidentStore {
  const byId = new Map<string, OperatorIncident>();
  const byKey = new Map<string, string>();

  const matching = (opts: IncidentListOptions = {}): OperatorIncident[] =>
    [...byId.values()]
      .filter((i) => !opts.scopeId || i.scopeLabel === opts.scopeId)
      .filter((i) => !opts.sessionId || i.sessionId === opts.sessionId)
      .filter((i) => !opts.status || i.status === opts.status)
      .filter((i) => !opts.severity || i.severity === opts.severity)
      .filter((i) => !opts.source || i.source === opts.source)
      .filter((i) => beforeCursor(i, opts.before))
      .sort((a, b) => b.occurredAt - a.occurredAt || b.id.localeCompare(a.id));

  return {
    async record(input) {
      const existingId = byKey.get(input.idempotencyKey);
      if (existingId) {
        const existing = byId.get(existingId)!;
        if (input.notificationRequested && !existing.notificationRequested) {
          const updated = { ...existing, notificationRequested: true, updatedAt: now() };
          byId.set(existingId, updated);
          return updated;
        }
        return existing;
      }
      const at = now();
      const incident: OperatorIncident = {
        ...input,
        id: input.id ?? randomUUID(),
        createdAt: at,
        updatedAt: at,
      };
      byId.set(incident.id, incident);
      byKey.set(incident.idempotencyKey, incident.id);
      return incident;
    },
    async get(id) {
      return byId.get(id) ?? null;
    },
    async list(opts = {}) {
      return matching(opts).slice(0, Math.max(1, opts.limit ?? 100));
    },
    async count(opts = {}) {
      return matching(opts).length;
    },
    async pendingNotifications(limit = 50) {
      return [...byId.values()]
        .filter((i) => i.notificationRequested && i.notificationQueuedAt === undefined)
        .sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id))
        .slice(0, Math.max(1, limit));
    },
    async pendingReceipts(limit = 50) {
      return [...byId.values()]
        .filter((i) => i.notificationDeliveryId && i.notificationDeliveredAt === undefined)
        .sort((a, b) => a.notificationQueuedAt! - b.notificationQueuedAt! || a.id.localeCompare(b.id))
        .slice(0, Math.max(1, limit));
    },
    async pendingEscalations(before, limit = 50) {
      return [...byId.values()]
        .filter(
          (i) => i.source === "backend" && i.status === "open" && !i.notificationRequested && i.occurredAt <= before,
        )
        .sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id))
        .slice(0, Math.max(1, limit));
    },
    async requestNotification(id, at) {
      const incident = byId.get(id);
      if (!incident || incident.status !== "open") return incident ?? null;
      const next = { ...incident, notificationRequested: true, updatedAt: at };
      byId.set(id, next);
      return next;
    },
    async markStatus(id, status, at) {
      const incident = byId.get(id);
      if (!incident) return null;
      const next = { ...incident, status, updatedAt: at };
      byId.set(id, next);
      return next;
    },
    async markNotificationQueued(id, deliveryId, at) {
      const incident = byId.get(id);
      if (!incident) return null;
      const next = { ...incident, notificationDeliveryId: deliveryId, notificationQueuedAt: at, updatedAt: at };
      byId.set(id, next);
      return next;
    },
    async markNotificationDelivered(id, at) {
      const incident = byId.get(id);
      if (!incident) return null;
      const next = { ...incident, notificationDeliveredAt: at, updatedAt: at };
      byId.set(id, next);
      return next;
    },
  };
}
