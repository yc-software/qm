import type { ShipGrant } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";

export interface ShipGrantStore {
  put(grant: ShipGrant): Promise<ShipGrant>;
  get(id: string): Promise<ShipGrant | null>;
  byLoop(loopId: string): Promise<ShipGrant[]>;
  revoke(id: string, actorId: string): Promise<ShipGrant | null>;
  delete(id: string): Promise<void>;
  deleteByLoop(loopId: string): Promise<void>;
}

export function createShipGrantStore(backing: DurableMap<ShipGrant> = createMemoryMap<ShipGrant>()): ShipGrantStore {
  if (!backing.update) throw new Error("ship grants need atomic durable updates");
  return {
    async put(grant) {
      const existing = await backing.putIfAbsent(grant.id, grant);
      if (existing.revokedAt === undefined) return existing;
      return (
        (await backing.update!(grant.id, (current) => {
          if (current.revokedAt === undefined) return current;
          const revocationHistory = [
            ...(current.revocationHistory ?? []),
            { revokedAt: current.revokedAt, revokedBy: current.revokedBy ?? "unknown" },
          ];
          const { revokedAt: _revokedAt, revokedBy: _revokedBy, ...active } = current;
          return { ...active, actorId: grant.actorId, createdAt: grant.createdAt, revocationHistory };
        })) ?? grant
      );
    },
    get: (id) => backing.get(id),
    async byLoop(loopId) {
      return (await backing.all()).filter((grant) => grant.loopId === loopId);
    },
    revoke: (id, actorId) =>
      backing.update!(id, (grant) =>
        grant.revokedAt === undefined ? { ...grant, revokedAt: Date.now(), revokedBy: actorId } : grant,
      ),
    async delete(id) {
      await backing.delete(id);
    },
    async deleteByLoop(loopId) {
      for (const grant of await this.byLoop(loopId)) await backing.delete(grant.id);
    },
  };
}
