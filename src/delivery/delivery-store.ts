import { randomUUID } from "node:crypto";
import type { Delivery, DeliveryProvenance, Destination, OutgoingAttachment, ScopeId } from "../types.ts";
import type { TurnOrigin } from "../core/turn-origin.ts";
import { cronIdOf } from "../sessions/session-store.ts";

export const DELIVERY_MAX_AGE_MS = 6 * 3_600_000;

export function logDeliveryExpiry(d: Delivery, now: number, reason = "overaged"): void {
  console.error(
    `[delivery] dropped undelivered after ${Math.round((now - d.createdAt) / 60_000)}m (${reason}): ` +
      `${d.destination.type} ${d.destination.target} id=${d.id}`,
  );
}

export function turnDeliveryProvenance(input: {
  origin: Pick<TurnOrigin, "kind">;
  surface: string | undefined;
  fireKey: string;
  sourceScopeId: ScopeId;
  sourceThreadRef: string;
  sourceSessionId?: string;
  sourceUserSeq?: number;
  sourceAssistantEntrySeq?: number;
}): DeliveryProvenance {
  return {
    trigger: input.origin.kind === "automation" ? (input.surface ?? "wake") : "conversation",
    surface: input.surface ?? "unknown",
    fireKey: input.fireKey,
    sourceScopeId: input.sourceScopeId,
    sourceThreadRef: input.sourceThreadRef,
    ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
    ...(input.sourceUserSeq !== undefined ? { sourceUserSeq: input.sourceUserSeq } : {}),
    ...(input.sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq: input.sourceAssistantEntrySeq } : {}),
  };
}

export interface DeliveryStore {
  enqueue(input: {
    destination: Destination;
    text: string;
    attachments?: OutgoingAttachment[];
    provenance?: DeliveryProvenance;
    idempotencyKey: string;
    shadow?: boolean;
  }): Promise<Delivery>;
  pending(type: string): Promise<Delivery[]>;
  claimPending(type: string, ttlMs: number): Promise<Delivery[]>;
  listShadow(opts?: { limit?: number }): Promise<Delivery[]>;
  ack(id: string, at: number, slackApiMs?: number): Promise<void>;
  ackByKey(idempotencyKey: string, at: number): Promise<void>;
  setEditRefByKey(idempotencyKey: string, editRef: string): Promise<void>;
  get(id: string): Promise<Delivery | null>;
  recordRecipientThread(id: string, recipientThreadRef: string, at: number): Promise<void>;
  listByRecipientThread(recipientThreadRef: string, opts?: { limit?: number }): Promise<Delivery[]>;
  listBySourceSession(sourceSessionId: string, sourceThreadRef: string, opts?: { limit?: number }): Promise<Delivery[]>;
  sentCountsBySourceSessions(sources: Array<{ sessionId: string; threadRef: string }>): Promise<Map<string, number>>;
  sentRunCountsByCron(cronIds: string[]): Promise<Map<string, number>>;
  onEnqueue(listener: () => void): () => void;
}

export function createDeliveryStore(opts?: { maxAgeMs?: number }): DeliveryStore {
  const maxAgeMs = opts?.maxAgeMs ?? DELIVERY_MAX_AGE_MS;
  const deliveries = new Map<string, Delivery>();
  const byKey = new Map<string, string>();
  const claimedUntil = new Map<string, number>();
  const enqueueListeners = new Set<() => void>();

  const expireOveraged = (now: number): void => {
    for (const d of deliveries.values()) {
      if (d.deliveredAt !== null || d.shadow || d.expiredAt !== undefined) continue;
      if ((claimedUntil.get(d.id) ?? 0) > now) continue;
      if (now - d.createdAt < maxAgeMs) continue;
      d.expiredAt = now;
      logDeliveryExpiry(d, now);
    }
  };

  return {
    async enqueue(input) {
      const existingId = byKey.get(input.idempotencyKey);
      if (existingId) {
        const existing = deliveries.get(existingId)!;
        if (existing.deliveredAt === null && existing.expiredAt !== undefined) {
          existing.destination = input.destination;
          existing.text = input.text;
          if (input.attachments?.length) existing.attachments = input.attachments;
          else delete existing.attachments;
          if (input.provenance) existing.provenance = input.provenance;
          else delete existing.provenance;
          existing.createdAt = Date.now();
          delete existing.expiredAt;
          claimedUntil.delete(existing.id);
          if (input.shadow) existing.shadow = true;
          else delete existing.shadow;
          if (!existing.shadow) for (const l of enqueueListeners) l();
        }
        return existing;
      }
      const delivery: Delivery = {
        id: randomUUID(),
        destination: input.destination,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
        idempotencyKey: input.idempotencyKey,
        createdAt: Date.now(),
        deliveredAt: null,
        ...(input.shadow ? { shadow: true } : {}),
      };
      deliveries.set(delivery.id, delivery);
      byKey.set(delivery.idempotencyKey, delivery.id);
      if (!delivery.shadow) for (const l of enqueueListeners) l();
      return delivery;
    },
    async pending(type) {
      return [...deliveries.values()].filter(
        (d) => d.deliveredAt === null && d.expiredAt === undefined && !d.shadow && d.destination.type === type,
      );
    },
    async claimPending(type, ttlMs) {
      const now = Date.now();
      expireOveraged(now);
      const rows = [...deliveries.values()].filter(
        (d) =>
          d.deliveredAt === null &&
          d.expiredAt === undefined &&
          !d.shadow &&
          d.destination.type === type &&
          (claimedUntil.get(d.id) ?? 0) <= now,
      );
      for (const d of rows) claimedUntil.set(d.id, now + ttlMs);
      return rows;
    },
    async listShadow(opts) {
      const limit = Math.max(1, opts?.limit ?? 100);
      return [...deliveries.values()]
        .filter((d) => d.shadow && d.deliveredAt === null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },
    async ack(id, at, slackApiMs) {
      const d = deliveries.get(id);
      if (d && d.deliveredAt === null) {
        d.deliveredAt = at;
        delete d.expiredAt;
        d.deliverLatencyMs = Math.max(0, at - d.createdAt);
        if (slackApiMs !== undefined) d.slackApiMs = slackApiMs;
      }
    },
    async ackByKey(idempotencyKey, at) {
      const existingId = byKey.get(idempotencyKey);
      if (existingId) {
        const d = deliveries.get(existingId);
        if (d && d.deliveredAt === null) {
          d.deliveredAt = at;
          delete d.expiredAt;
        }
        return;
      }
      const tombstone: Delivery = {
        id: randomUUID(),
        destination: { type: "ack-tombstone", target: "" },
        text: "",
        idempotencyKey,
        createdAt: at,
        deliveredAt: at,
      };
      deliveries.set(tombstone.id, tombstone);
      byKey.set(idempotencyKey, tombstone.id);
    },
    async setEditRefByKey(idempotencyKey, editRef) {
      const existingId = byKey.get(idempotencyKey);
      const d = existingId ? deliveries.get(existingId) : undefined;
      if (d && d.deliveredAt === null) d.destination = { ...d.destination, editRef };
    },
    async get(id) {
      return deliveries.get(id) ?? null;
    },
    async recordRecipientThread(id, recipientThreadRef, at) {
      const d = deliveries.get(id);
      if (!d || d.destination.type !== "principal") return;
      d.recipientThreadRef = recipientThreadRef;
      if (d.deliveredAt === null) {
        d.deliveredAt = at;
        delete d.expiredAt;
      }
    },
    async listByRecipientThread(recipientThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      return [...deliveries.values()]
        .filter((d) => d.recipientThreadRef === recipientThreadRef && d.destination.type === "principal")
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit);
    },
    async listBySourceSession(sourceSessionId, sourceThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      return [...deliveries.values()]
        .filter(
          (d) => d.provenance?.sourceSessionId === sourceSessionId || d.provenance?.sourceThreadRef === sourceThreadRef,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit);
    },
    async sentCountsBySourceSessions(sources) {
      const counts = new Map<string, number>();
      const byId = new Set(sources.map((s) => s.sessionId));
      const byThreadRef = new Map(sources.map((s) => [s.threadRef, s.sessionId]));
      for (const d of deliveries.values()) {
        if (d.shadow || d.expiredAt !== undefined || !d.provenance) continue;
        let id: string | undefined;
        if (d.provenance.sourceSessionId) {
          if (byId.has(d.provenance.sourceSessionId)) id = d.provenance.sourceSessionId;
        } else if (d.provenance.sourceThreadRef) {
          id = byThreadRef.get(d.provenance.sourceThreadRef);
        }
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    },
    async sentRunCountsByCron(cronIds) {
      const wanted = new Set(cronIds);
      const runs = new Map<string, Set<string>>();
      for (const d of deliveries.values()) {
        if (d.shadow || d.expiredAt !== undefined || !d.provenance?.sourceThreadRef) continue;
        const cronId = cronIdOf(d.provenance.sourceThreadRef);
        if (!cronId || !wanted.has(cronId)) continue;
        let set = runs.get(cronId);
        if (!set) runs.set(cronId, (set = new Set()));
        set.add(d.provenance.sourceSessionId ?? d.provenance.sourceThreadRef);
      }
      return new Map([...runs].map(([k, v]) => [k, v.size]));
    },
    onEnqueue(listener) {
      enqueueListeners.add(listener);
      return () => enqueueListeners.delete(listener);
    },
  };
}
