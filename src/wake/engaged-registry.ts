import { currentTenant } from "../tenants/context.ts";

export interface EngagedSession {
  tenantId: string;
  threadRef: string;
}

export interface EngagedRegistry {
  engage(threadRef: string): void;
  settle(threadRef: string): void;
  list(): EngagedSession[];
}

export function createEngagedRegistry(): EngagedRegistry {
  const engaged = new Map<string, EngagedSession>();
  const key = (threadRef: string): string => JSON.stringify([currentTenant(), threadRef]);
  return {
    engage: (threadRef) => void engaged.set(key(threadRef), { tenantId: currentTenant(), threadRef }),
    settle: (threadRef) => void engaged.delete(key(threadRef)),
    list: () => [...engaged.values()],
  };
}
