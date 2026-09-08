import type { ScopeId } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export const EGRESS_STAMPS_TABLE = "egress_stamps";

export interface EgressStamp {
  at: number;
  scopeLabel: ScopeId;
  principalId: string;
  host: string;
}

export interface EgressStampStore {
  stamp(execId: string, rec: Omit<EgressStamp, "at">): Promise<void>;
  has(execId: string): Promise<boolean>;
}

export function createEgressStampStore(map: DurableMap<EgressStamp>): EgressStampStore {
  return {
    async stamp(execId, rec) {
      await map.putIfAbsent(execId, { at: Date.now(), ...rec });
    },
    async has(execId) {
      return (await map.get(execId)) !== null;
    },
  };
}
