import { randomUUID } from "node:crypto";
import type { CoordinationRepository } from "./repository.ts";
import type { PeerDelivery } from "./types.ts";

export function createPeerDeliveryLedger(repository: CoordinationRepository) {
  return {
    async claim(id: string, at?: number, leaseMs = 30_000): Promise<PeerDelivery | null> {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error("invalid delivery lease duration");
      return repository.transaction([`delivery:${id}`], async (tx) => {
        const now = at ?? Date.now();
        const current = await tx.get("delivery", id);
        if (!current || current.state === "delivered" || current.state === "failed" || current.leaseUntil > now)
          return null;
        const delivery: PeerDelivery = {
          ...current,
          attempts: current.attempts + 1,
          leaseToken: randomUUID(),
          leaseUntil: now + leaseMs,
          updatedAt: now,
        };
        await tx.put("delivery", delivery);
        await tx.event("delivery", id, now);
        return delivery;
      });
    },
    async bind(id: string, leaseToken: string, runId: string, at?: number): Promise<boolean> {
      return repository.transaction([`delivery:${id}`], async (tx) => {
        const now = at ?? Date.now();
        const current = await tx.get("delivery", id);
        if (!current || current.leaseToken !== leaseToken || current.leaseUntil <= now || current.state === "delivered")
          return false;
        await tx.put("delivery", { ...current, runId, updatedAt: now });
        await tx.event("delivery", id, now);
        return true;
      });
    },
    async settle(
      id: string,
      leaseToken: string,
      state: "queued" | "delivered" | "blocked" | "failed",
      reason: string | null = null,
      at?: number,
    ): Promise<boolean> {
      return repository.transaction([`delivery:${id}`], async (tx) => {
        const now = at ?? Date.now();
        const current = await tx.get("delivery", id);
        if (!current || current.leaseToken !== leaseToken || current.leaseUntil <= now || current.state === "delivered")
          return false;
        await tx.put("delivery", { ...current, state, reason, updatedAt: now, leaseToken: null, leaseUntil: 0 });
        await tx.event("delivery", id, now);
        return true;
      });
    },
  };
}
