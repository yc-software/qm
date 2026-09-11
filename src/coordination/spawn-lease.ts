import { randomUUID } from "node:crypto";
import type { CoordinationRepository } from "./repository.ts";
import { CoordinationError, type PeerSpawn } from "./types.ts";

export function assertSpawnLease(spawn: PeerSpawn | null, token: string, now = Date.now()): asserts spawn is PeerSpawn {
  if (!spawn || spawn.leaseToken !== token || spawn.leaseUntil <= now || spawn.state === "ready")
    throw new CoordinationError(409, "spawn_lease_lost", "spawn attempt no longer owns its lease");
}

export function createSpawnLease(repository: CoordinationRepository) {
  return {
    async claim(id: string, at?: number, leaseMs = 300_000): Promise<PeerSpawn | null> {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error("invalid spawn lease duration");
      return repository.transaction([`spawn:${id}`], async (tx) => {
        const now = at ?? Date.now();
        const spawn = await tx.get("spawn", id);
        if (!spawn) throw new CoordinationError(404, "spawn_not_found", "spawn not found");
        if (spawn.state === "ready" || spawn.leaseUntil > now) return null;
        const claimed = {
          ...spawn,
          leaseToken: randomUUID(),
          leaseUntil: now + leaseMs,
          attempts: spawn.attempts + 1,
          updatedAt: now,
        };
        await tx.put("spawn", claimed);
        await tx.event("spawn", id, now);
        return claimed;
      });
    },
    async save(
      id: string,
      token: string,
      change: Partial<Pick<PeerSpawn, "state" | "reason" | "runId" | "sandboxId">>,
      at?: number,
    ): Promise<PeerSpawn> {
      return repository.transaction([`spawn:${id}`], async (tx) => {
        const now = at ?? Date.now();
        const current = await tx.get("spawn", id);
        assertSpawnLease(current, token, now);
        const release = change.state === "ready" || change.state === "failed";
        const updated = {
          ...current,
          ...change,
          updatedAt: now,
          ...(release ? { leaseToken: null, leaseUntil: 0 } : {}),
        };
        await tx.put("spawn", updated);
        await tx.event("spawn", id, now);
        return updated;
      });
    },
  };
}
