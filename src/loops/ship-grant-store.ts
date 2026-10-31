import type { ShipGrant } from "../types.ts";
import { createMemoryShipGrantRows, type ShipGrantRows } from "./ship-grant-table.ts";

export interface ShipGrantStore {
  put(grant: ShipGrant): Promise<ShipGrant>;
  get(id: string): Promise<ShipGrant | null>;
  byLoop(loopId: string): Promise<ShipGrant[]>;
  revoke(id: string, actorId: string): Promise<ShipGrant | null>;
  delete(id: string): Promise<void>;
  deleteByLoop(loopId: string): Promise<void>;
}

export function createShipGrantStore(rows: ShipGrantRows = createMemoryShipGrantRows()): ShipGrantStore {
  return {
    async put(grant) {
      const existing = await rows.insertIfAbsent(grant);
      if (existing.revokedAt === undefined) return existing;
      return (
        (await rows.update(grant.id, (current) => {
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
    get: (id) => rows.get(id),
    byLoop: (loopId) => rows.byLoop(loopId),
    revoke: (id, actorId) =>
      rows.update(id, (grant) =>
        grant.revokedAt === undefined ? { ...grant, revokedAt: Date.now(), revokedBy: actorId } : grant,
      ),
    delete: (id) => rows.delete(id),
    deleteByLoop: (loopId) => rows.deleteByLoop(loopId),
  };
}
