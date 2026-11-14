import type { ShipGrant } from "./types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { msOf } from "../sessions/items.ts";
import { madeByAliases } from "../triggers/trigger-store.ts";

export const revokeGrantsByAliases = (by: string): string => `granted AS (
  SELECT g.id, l.json ->> 'ownerScopeId' AS scope, l.id AS loop_id
    FROM loop_ship_grants g JOIN loops l ON l.id = g.json ->> 'loopId'
   WHERE NOT g.json ? 'revokedAt' AND ${madeByAliases("g.json ->> 'actorId'")}
), grants_revoked AS (
  UPDATE loop_ship_grants g SET json = g.json || jsonb_build_object('revokedAt', ${msOf("now()")}, 'revokedBy', ${by})
    FROM granted x WHERE g.id = x.id
  RETURNING 'loop_ship_grants' AS tbl, 'ship_grant_revoke' AS action, g.id, x.scope, jsonb_build_object('loopId', x.loop_id) AS detail
)`;

export interface ShipGrantStore {
  put(grant: ShipGrant): Promise<ShipGrant>;
  get(id: string): Promise<ShipGrant | null>;
  byLoop(loopId: string): Promise<ShipGrant[]>;
  revoke(id: string, actorId: string): Promise<ShipGrant | null>;
  delete(id: string): Promise<void>;
  deleteByLoop(loopId: string): Promise<void>;
}

export function createShipGrantStore(backing: DurableMap<ShipGrant>): ShipGrantStore {
  return {
    async put(grant) {
      const existing = await backing.putIfAbsent(grant.id, grant);
      if (existing.revokedAt === undefined) return existing;
      return (
        (await backing.update(grant.id, (current) => {
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
      backing.update(id, (grant) =>
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
