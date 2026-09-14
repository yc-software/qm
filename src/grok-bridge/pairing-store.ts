import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { hashId } from "../util/crypto.ts";
import type { GrokPairing, PairingStore } from "./types.ts";

export type { PairingStore } from "./types.ts";

export function createPairingStore(backing: DurableMap<GrokPairing> = createMemoryMap<GrokPairing>()): PairingStore {
  return {
    async create(pairing) {
      const id = pairing.id || hashId([pairing.ownerPrincipalId, pairing.agentName, String(pairing.createdAt)]);
      const record = { ...pairing, id };
      await backing.put(id, record);
      return record;
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    async save(pairing) {
      await backing.put(pairing.id, pairing);
      return pairing;
    },
    async findActive(ownerPrincipalId, agentName) {
      const all = await backing.all();
      return (
        all
          .filter(
            (row) =>
              row.ownerPrincipalId === ownerPrincipalId && row.agentName === agentName && row.status !== "revoked",
          )
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0] ?? null
      );
    },
  };
}
